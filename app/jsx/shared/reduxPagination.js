/*
 * Copyright (C) 2017 - present Instructure, Inc.
 *
 * This file is part of Canvas.
 *
 * Canvas is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, version 3 of the License.
 *
 * Canvas is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License along
 * with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import { combineReducers } from 'redux'
import { handleActions } from 'redux-actions'
import parseLinkHeader from 'jsx/shared/helpers/parseLinkHeader'

const DEFAULT_PAGE = 1

// enum-like helper for load states
export const LoadStates = (function initLoadStates () {
  const statesList = ['NOT_LOADED', 'LOADING', 'LOADED', 'ERRORED']
  const states = statesList.reduce((map, state) =>
    Object.assign(map, {
      [state]: state,
    }), {})

  return {
    ...states,
    statesList,
    isLoading: state => state === states.LOADING,
    hasLoaded: state => state === states.LOADED,
    isNotLoaded: state => state === states.NOT_LOADED,
  }
}())

function createActionTypes (name) {
  const upperName = name.toUpperCase()
  return {
    select: `SELECT_${upperName}_PAGE`,
    start: `GET_${upperName}_START`,
    success: `GET_${upperName}_SUCCESS`,
    fail: `GET_${upperName}_FAIL`,
  }
}

/**
 * Creates a reducer for an individual page that keeps track of loading
 * state and data for that page
 *
 * @param {object} actions object returned by createActionTypes
 */
 function createReducePage (actions) {
  return combineReducers({
    loadState: handleActions({
      [actions.start]: () => LoadStates.LOADING,
      [actions.success]: () => LoadStates.LOADED,
      [actions.fail]: () => LoadStates.ERRORED,
    }, LoadStates.NOT_LOADED),
    items: handleActions({
      [actions.success]: (state, action) => action.payload.data,
    }, []),
  })
}

/**
 * Creates a reducer that manages the pages collection for a paginated data set
 *
 * @param {object} actions object returned by createActionTypes
 */
function createPagesReducer (actions) {
  return function reducePages (state = {}, action) {
    const page = action.payload ? action.payload.page : null
    if (!page) return state // page is a required prop on payload
    const pageState = state[page]
    return Object.assign({}, state, {
      [page]: createReducePage(actions)(pageState, action)
    })
  }
}

/**
 * Creates a reducer that manages the state for paginated data
 * It will keep track of data and load state for individual pages as well as
 * what page the current page is and the max number of pages
 * Add it in your root reducer! The given name is used to determine what
 * actions this reducer will respond to
 *
 * @param {string} name name that is used in pagination action types
 *
 * @example
 * combineReducers({
 *  users: handleActions({
 *    // your reducer here
 *  }, []),
 *
 *  // items will have .currentPage, .lastPage, etc
 *  // items will respond to GET_ITEMS_START, etc
 *  items: createPaginatedReducer('items'),
 * })
 */
export function createPaginatedReducer (name) {
  const actions = createActionTypes(name)
  return combineReducers({
    currentPage: handleActions({
      [actions.select]: (state, action) => action.payload.page,
    }, DEFAULT_PAGE),
    lastPage: handleActions({
      [actions.success]: (state, action) => action.payload.lastPage || state,
    }, DEFAULT_PAGE),
    pages: createPagesReducer(actions),
  })
}

function wrapGetPageThunk (actions, name, thunk) {
  /**
   * payload params:
   * @param {integer} page page to select/fetch
   * @param {bool} select whether to select the page we are fetching
   * @param {bool} forceGet if page is already loaded, force get it anyway
   */
  return (payload = {}) => (dispatch, getState) => {
    if (payload.select) {
      dispatch({ type: actions.select, payload: { page: payload.page } })
    }

    const state = getState()
    const page =  payload.page || state[name].currentPage
    const pageData = state[name].pages[page] || {}

    // only fetch page data is it has not been loaded or we are force getting it
    if (!LoadStates.hasLoaded(pageData.loadState) || payload.forceGet) {
      dispatch({ type: actions.start, payload: { page }})

      new Promise(thunk(dispatch, getState, { page }))
      .then(res => {
        const successPayload = { page, data: res.data }

        // sometimes the canvas API provides us with link header that gives
        // us the URL to the last page. we can try parse that URL to determine
        // how many pages there are in total
        // works only with axios res objects, aka assumes thunk is axios promise
        const links = parseLinkHeader(res)
        if (links.last) {
          try {
            successPayload.lastPage = Number(/&page=([0-9]+)&/.exec(links.last)[1])
          } catch (e) {} // eslint-disable-line
        }
        dispatch({ type: actions.success, payload: successPayload })
      })
      .catch(err => {
        dispatch({ type: actions.fail, payload: { page, ...err } })
      })
    }
  }
}

/**
 * Creates actions types and action creators for paginating a set of data
 *
 * for name "items", action types will be:
 * - SELECT_ITEMS_PAGE
 * - GET_ITEMS_START
 * - GET_ITEMS_SUCCESS
 * - GET_ITEMS_FAIL
 *
 * for name "items", action creators will be:
 * - getItems - redux-thunk action creator that will execute the given thunk
 *
 * @param {string} name name of the data set
 * @param {function} thunk function that will get our data
 *
 * thunk must follow a promise-like interface:
 * @example
 * thunk = (dispatch, getState) => (resolve, reject) => {
 *   // your async logic here that calls resolve / reject
 *   // if actions is success / fail and has access to the store's
 *   // dispatch / getState just like any other thunk
 * }
 *
 * @example
 * function fetchItems (dispatch, getState) {
 *   return (resolve, reject) =>
 *     axios.get('/api/v1/items')
 *       .then(resolve)
 *       .catch(reject)
 * }
 * const itemActions = createPaginationActions('items', fetchItems)
 *
 * // calls fetchItems but dispatches START/SUCCESS/FAIL to store for the page
 * itemActions.actionCreators.getItems({ page: 3 })
 */
export function createPaginationActions (name, thunk) {
  const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1)
  const actionTypes = createActionTypes(name)
  return {
    actionTypes: Object.keys(actionTypes).map(key => actionTypes[key]),
    actionCreators: {
      [`get${capitalizedName}`]: wrapGetPageThunk(actionTypes, name, thunk),
    },
  }
}

/**
 * Redux state selector function that transforms internal redux pagination
 * state into props that are more friendly for a component to use
 *
 * @param {obj} state redux store state to look into
 * @param {string} name key into state for paginated data
 */
export function selectPaginationState (state, name) {
  const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1)
  const itemsState = state[name]
  const page = itemsState.pages[itemsState.currentPage] || {}
  return {
    [name]: page.items || [],
    [`${name}Page`]: itemsState.currentPage,
    [`isLoading${capitalizedName}`]: LoadStates.isLoading(page.loadState),
    [`hasLoaded${capitalizedName}`]: LoadStates.hasLoaded(page.loadState),
  }
}