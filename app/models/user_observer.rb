#
# Copyright (C) 2011 - present Instructure, Inc.
#
# This file is part of Canvas.
#
# Canvas is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by the Free
# Software Foundation, version 3 of the License.
#
# Canvas is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
# A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
# details.
#
# You should have received a copy of the GNU Affero General Public License along
# with this program. If not, see <http://www.gnu.org/licenses/>.
#

# if the observer and observee are on different shards, the "primary" record belongs
# on the same shard as the observee, but a duplicate record is also created on the
# other shard

class UserObserver < ActiveRecord::Base
  belongs_to :user, inverse_of: :user_observees
  belongs_to :observer, :class_name => 'User', inverse_of: :user_observers
  after_create :create_linked_enrollments

  validate :not_same_user, :if => lambda { |uo| uo.changed? }

  scope :active, -> { where.not(workflow_state: 'deleted') }

  # shadow_record param is private
  def self.create_or_restore(observee: , observer: , shadow_record: false)
    shard = shadow_record ? observer.shard : observee.shard
    result = shard.activate do
      UserObserver.unique_constraint_retry do
        if (uo = UserObserver.where(user: observee, observer: observer).take)
          if uo.workflow_state == 'deleted'
            uo.workflow_state = 'active'
            uo.sis_batch_id = nil
            uo.save!
          end
        else
          uo = create!(user: observee, observer: observer)
        end
        uo
      end
    end

    if result.primary_record?
      # create the shadow record
      create_or_restore(observee: observee, observer: observer, shadow_record: true) if result.cross_shard?

      result.create_linked_enrollments
      result.user.touch
    end

    result
  end

  alias_method :destroy_permanently!, :destroy
  def destroy
    other_record&.destroy
    self.workflow_state = 'deleted'
    self.save!
    remove_linked_enrollments if primary_record?
  end

  def not_same_user
    self.errors.add(:observer_id, "Cannot observe yourself") if self.user_id == self.observer_id
  end

  def create_linked_enrollments
    self.class.connection.after_transaction_commit do
      User.skip_updating_account_associations do
        user.student_enrollments.shard(user).all_active_or_pending.order("course_id").each do |enrollment|
          next unless enrollment.valid?
          enrollment.create_linked_enrollment_for(observer)
        end

        observer.update_account_associations
      end
    end
  end

  def remove_linked_enrollments
    observer.observer_enrollments.shard(observer).where(associated_user_id: user).find_each do |enrollment|
      enrollment.workflow_state = 'deleted'
      enrollment.save!
    end
    observer.update_account_associations
    observer.touch
  end

  def cross_shard?
    Shard.shard_for(user_id) != Shard.shard_for(observer_id)
  end

  def primary_record?
    shard == Shard.shard_for(user_id)
  end

  private

  def other_record
    if cross_shard?
      primary_record? ? shadow_record : self
    end
  end

  def primary_record
    if cross_shard? && !primary_record?
      Shard.shard_for(user_id).activate do
        UserObserver.where(user_id: user_id, observer_id: observer_id).take!
      end
    else
      self
    end
  end

  def shadow_record
    if !cross_shard? || !primary_record?
      self
    else
      Shard.shard_for(observer_id).activate do
        UserObserver.where(user_id: user_id, observer_id: observer_id).take!
      end
    end
  end
end
