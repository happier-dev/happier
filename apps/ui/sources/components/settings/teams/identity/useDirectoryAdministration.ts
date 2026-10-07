import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    serverAccountScopedTeamKey,
    serverAccountScopedTeamResourceKey,
    type TeamAddress,
} from '@/sync/domains/teams/teamAddress';
import type {
    TeamDirectoryActionIdV1,
    TeamDirectorySourcePageV1,
    TeamDirectorySourceRemovalPreflightV1,
    TeamDirectorySourceRemoveResultV1,
    TeamDirectorySourceSummaryV1,
} from '@happier-dev/protocol/teams';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { IdentityAdministrationActionResult } from './identityAdministrationClient';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import {
    beginDirectoryAdministrationContinuation,
    beginDirectoryAdministrationRefresh,
    beginDirectorySourceAdministrationRefresh,
    INITIAL_DIRECTORY_ADMINISTRATION_STATE,
    INITIAL_DIRECTORY_SOURCE_ADMINISTRATION_STATE,
    settleDirectoryAdministrationContinuation,
    settleDirectoryAdministrationRefresh,
    settleDirectorySourceAdministrationRefresh,
    type DirectoryAdministrationState,
    type DirectorySourceAdministrationState,
} from './directoryAdministrationState';
import { createIdentityAdministrationClient, executeIdentityAdministrationRead } from './identityAdministrationClient';

type BoundState<Value> = Readonly<{
    bindingKey: string;
    value: Value;
}>;

export function useDirectoryAdministration(
    scope: ServerAccountScope,
    teamId: string,
    enabled = true,
    onApprovalPending?: (registration: ActionApprovalRegistration) => void,
): Readonly<{
    state: DirectoryAdministrationState;
    refresh: () => void;
    loadMore: () => Promise<void>;
}> {
    const address: TeamAddress = { serverId: scope.serverId, teamId };
    const bindingKey = serverAccountScopedTeamKey(scope, address);
    const [boundState, setBoundState] = React.useState<BoundState<DirectoryAdministrationState>>(() => ({
        bindingKey,
        value: INITIAL_DIRECTORY_ADMINISTRATION_STATE,
    }));
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);
    const requestEpochRef = React.useRef(0);
    const requestControllerRef = React.useRef<AbortController | null>(null);
    const client = React.useMemo(
        () => createIdentityAdministrationClient(scope, { onApprovalPending }),
        [onApprovalPending, scope.serverId, scope.accountId],
    );
    const state = boundState.bindingKey === bindingKey
        ? boundState.value
        : INITIAL_DIRECTORY_ADMINISTRATION_STATE;

    React.useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        requestControllerRef.current = controller;
        const requestEpoch = requestEpochRef.current + 1;
        requestEpochRef.current = requestEpoch;
        setBoundState((current) => ({
            bindingKey,
            value: current.bindingKey === bindingKey
                ? beginDirectoryAdministrationRefresh(current.value)
                : INITIAL_DIRECTORY_ADMINISTRATION_STATE,
        }));
        void executeIdentityAdministrationRead<TeamDirectorySourcePageV1>(
            (options) => client.executeDirectory('teams.directory.sources.list', { v: 1, teamId }, options),
            controller.signal,
        ).then((result) => {
            if (controller.signal.aborted || requestEpochRef.current !== requestEpoch) return;
            setBoundState((current) => current.bindingKey !== bindingKey
                ? current
                : {
                    bindingKey,
                    value: settleDirectoryAdministrationRefresh(
                        current.value,
                        result.ok
                            ? { ok: true, items: result.value.items, nextCursor: result.value.nextCursor }
                            : { ok: false, failure: result.failure },
                    ),
                });
        });
        return () => {
            controller.abort();
            if (requestControllerRef.current === controller) requestControllerRef.current = null;
        };
    }, [bindingKey, client, enabled, teamId, refreshGeneration]);

    const refresh = React.useCallback(() => {
        if (!enabled) return;
        requestEpochRef.current += 1;
        setBoundState((current) => current.bindingKey !== bindingKey
            ? current
            : { bindingKey, value: beginDirectoryAdministrationRefresh(current.value) });
        setRefreshGeneration((value) => value + 1);
    }, [bindingKey, enabled]);
    const loadMore = React.useCallback(async () => {
        if (!enabled
            || state.kind !== 'ready'
            || state.refreshing
            || state.loadingMore
            || state.stale
            || state.nextCursor === null) {
            return;
        }
        const cursor = state.nextCursor;
        const requestEpoch = requestEpochRef.current;
        const controller = requestControllerRef.current;
        if (!controller || controller.signal.aborted) return;
        setBoundState((current) => current.bindingKey !== bindingKey
            ? current
            : { bindingKey, value: beginDirectoryAdministrationContinuation(current.value) });
        const result = await executeIdentityAdministrationRead<TeamDirectorySourcePageV1>(
            (options) => client.executeDirectory('teams.directory.sources.list', { v: 1, teamId, cursor }, options),
            controller.signal,
        );
        if (controller.signal.aborted || requestEpochRef.current !== requestEpoch) return;
        setBoundState((current) => {
            if (current.bindingKey !== bindingKey
                || current.value.kind !== 'ready'
                || current.value.nextCursor !== cursor) return current;
            return {
                bindingKey,
                value: settleDirectoryAdministrationContinuation(
                    current.value,
                    result.ok
                        ? { ok: true, items: result.value.items, nextCursor: result.value.nextCursor }
                        : { ok: false, failure: result.failure },
                ),
            };
        });
    }, [bindingKey, client, enabled, state, teamId]);
    React.useEffect(() => {
        if (!enabled) return;
        return subscribeHomeAccountChange((event) => {
            if (event.serverId !== scope.serverId) return;
            if (event.entityIds !== undefined
                && !event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) return;
            refresh();
        });
    }, [enabled, refresh, scope.serverId]);
    return React.useMemo(() => ({ state, refresh, loadMore }), [loadMore, refresh, state]);
}

export function useDirectorySourceAdministration(
    scope: ServerAccountScope,
    teamId: string,
    sourceId: string,
    onApprovalPending?: (registration: ActionApprovalRegistration) => void,
): Readonly<{
    state: DirectorySourceAdministrationState;
    refresh: () => void;
    pendingAction: TeamDirectoryActionIdV1 | 'removal-impact' | null;
    runAction: (
        actionId: Extract<TeamDirectoryActionIdV1,
            | 'teams.directory.sources.sync'
            | 'teams.directory.sources.pause'
            | 'teams.directory.sources.resume'
            | 'teams.directory.sources.remove'>,
        options?: Readonly<{
            onApprovalSucceeded?: () => void | Promise<void>;
            onApprovalFailed?: (code: string) => void;
        }>,
    ) => Promise<IdentityAdministrationActionResult<unknown>>;
    readRemovalImpact: () => Promise<IdentityAdministrationActionResult<TeamDirectorySourceRemovalPreflightV1>>;
    removeSource: (options?: Readonly<{
        onApprovalSucceeded?: (value: TeamDirectorySourceRemoveResultV1) => void | Promise<void>;
        onApprovalFailed?: (code: string) => void;
    }>) => Promise<IdentityAdministrationActionResult<TeamDirectorySourceRemoveResultV1>>;
}> {
    const address: TeamAddress = { serverId: scope.serverId, teamId };
    const bindingKey = serverAccountScopedTeamResourceKey(scope, address, 'directory-source', sourceId);
    const [boundState, setBoundState] = React.useState<BoundState<DirectorySourceAdministrationState>>(() => ({
        bindingKey,
        value: INITIAL_DIRECTORY_SOURCE_ADMINISTRATION_STATE,
    }));
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);
    const [boundPendingAction, setBoundPendingAction] = React.useState<BoundState<TeamDirectoryActionIdV1 | 'removal-impact' | null>>(() => ({
        bindingKey,
        value: null,
    }));
    const client = React.useMemo(
        () => createIdentityAdministrationClient(scope, { onApprovalPending }),
        [onApprovalPending, scope.serverId, scope.accountId],
    );
    const state = boundState.bindingKey === bindingKey
        ? boundState.value
        : INITIAL_DIRECTORY_SOURCE_ADMINISTRATION_STATE;
    const pendingAction = boundPendingAction.bindingKey === bindingKey
        ? boundPendingAction.value
        : null;
    const removalPreviewControllerRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => removalPreviewControllerRef.current?.abort(), [bindingKey]);

    React.useEffect(() => {
        const controller = new AbortController();
        setBoundState((current) => ({
            bindingKey,
            value: current.bindingKey === bindingKey
                ? beginDirectorySourceAdministrationRefresh(current.value)
                : INITIAL_DIRECTORY_SOURCE_ADMINISTRATION_STATE,
        }));
        void executeIdentityAdministrationRead<TeamDirectorySourceSummaryV1>(
            (options) => client.executeDirectory('teams.directory.sources.get', { v: 1, teamId, sourceId }, options),
            controller.signal,
        ).then((result) => {
            if (controller.signal.aborted) return;
            setBoundState((current) => current.bindingKey !== bindingKey
                ? current
                : {
                    bindingKey,
                    value: settleDirectorySourceAdministrationRefresh(
                        current.value,
                        result.ok
                            ? { ok: true, item: result.value }
                            : { ok: false, failure: result.failure },
                    ),
                });
        });
        return () => controller.abort();
    }, [bindingKey, client, sourceId, teamId, refreshGeneration]);

    const refresh = React.useCallback(() => setRefreshGeneration((value) => value + 1), []);
    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (event.serverId !== scope.serverId) return;
        if (event.entityIds !== undefined
            && !event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) return;
        refresh();
    }), [refresh, scope.serverId]);
    const runAction = React.useCallback(async (
        actionId: Extract<TeamDirectoryActionIdV1,
            | 'teams.directory.sources.sync'
            | 'teams.directory.sources.pause'
            | 'teams.directory.sources.resume'
            | 'teams.directory.sources.remove'>,
        options?: Readonly<{
            onApprovalSucceeded?: () => void | Promise<void>;
            onApprovalFailed?: (code: string) => void;
        }>,
    ): Promise<IdentityAdministrationActionResult<unknown>> => {
        setBoundPendingAction({ bindingKey, value: actionId });
        try {
            const result = await client.executeDirectory(actionId, { v: 1, teamId, sourceId }, {
                onApprovalSucceeded: async () => {
                    if (actionId !== 'teams.directory.sources.remove') refresh();
                    await options?.onApprovalSucceeded?.();
                },
                ...(options?.onApprovalFailed ? { onApprovalFailed: options.onApprovalFailed } : {}),
            });
            if (result.ok && actionId !== 'teams.directory.sources.remove') refresh();
            return result;
        } finally {
            setBoundPendingAction((current) => current.bindingKey === bindingKey
                ? { bindingKey, value: null }
                : current);
        }
    }, [bindingKey, client, refresh, sourceId, teamId]);
    const readRemovalImpact = React.useCallback(async () => {
        removalPreviewControllerRef.current?.abort();
        const controller = new AbortController();
        removalPreviewControllerRef.current = controller;
        setBoundPendingAction({ bindingKey, value: 'removal-impact' });
        try {
            return await executeIdentityAdministrationRead<TeamDirectorySourceRemovalPreflightV1>(
                (options) => client.executeDirectory('teams.directory.sources.remove.preview', { v: 1, teamId, sourceId }, options),
                controller.signal,
            );
        } finally {
            if (removalPreviewControllerRef.current === controller) {
                removalPreviewControllerRef.current = null;
                setBoundPendingAction((current) => current.bindingKey === bindingKey
                    ? { bindingKey, value: null }
                    : current);
            }
        }
    }, [bindingKey, client, sourceId, teamId]);
    const removeSource = React.useCallback(async (options?: Readonly<{
        onApprovalSucceeded?: (value: TeamDirectorySourceRemoveResultV1) => void | Promise<void>;
        onApprovalFailed?: (code: string) => void;
    }>) => {
        setBoundPendingAction({ bindingKey, value: 'teams.directory.sources.remove' });
        try {
            return await client.executeDirectory(
                'teams.directory.sources.remove',
                { v: 1, teamId, sourceId },
                options,
            );
        } finally {
            setBoundPendingAction((current) => current.bindingKey === bindingKey
                ? { bindingKey, value: null }
                : current);
        }
    }, [bindingKey, client, sourceId, teamId]);
    return React.useMemo(
        () => ({ state, refresh, pendingAction, runAction, readRemovalImpact, removeSource }),
        [pendingAction, readRemovalImpact, refresh, removeSource, runAction, state],
    );
}
