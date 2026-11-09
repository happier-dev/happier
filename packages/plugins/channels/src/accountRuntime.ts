import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { manageSessionPullRequestWatchForInvocation, observeSessionPullRequestWatchAction } from './sessionPullRequestWatch.js';
import { SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1, readSessionPullRequestRelationsForInvocation,
    observeSessionPullRequestBindingAction } from './sessionPullRequestRelations.js';

/** Retained relationships and Watch Actions use admitted Account state on every client. */
export function activate(api: PluginAccountApi): void {
    api.actions.register(SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1, readSessionPullRequestRelationsForInvocation,
        { observeRead: observeSessionPullRequestBindingAction });
    api.actions.register(SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1, manageSessionPullRequestWatchForInvocation,
        { observeRead: observeSessionPullRequestWatchAction });
}
