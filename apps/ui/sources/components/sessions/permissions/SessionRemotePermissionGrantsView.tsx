import * as React from 'react';

import {
    SessionPermissionRemoteGrantRevokeOutputV1Schema,
    SessionPermissionRemoteGrantsListOutputV1Schema,
    type SessionPermissionRemoteGrantSummaryV1,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

const REMOTE_PERMISSION_GRANTS_PAGE_SIZE = 50;

type OwnerGrant = SessionPermissionRemoteGrantSummaryV1 & Readonly<{
    projection: Extract<SessionPermissionRemoteGrantSummaryV1['projection'], Readonly<{ kind: 'owner' }>>;
}>;

type GrantListState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; code: string }>
    | Readonly<{
        kind: 'ready';
        grants: readonly OwnerGrant[];
        nextCursor: string | null;
        loadingMore: boolean;
    }>;

type OperationIssue = 'loadMore' | 'revoke';

function isOwnerGrant(grant: SessionPermissionRemoteGrantSummaryV1): grant is OwnerGrant {
    return grant.projection.kind === 'owner';
}

function mergeGrants(current: readonly OwnerGrant[], next: readonly OwnerGrant[]): readonly OwnerGrant[] {
    const merged = new Map(current.map((grant) => [grant.grantId, grant] as const));
    for (const grant of next) {
        merged.set(grant.grantId, grant);
    }
    return [...merged.values()];
}

function formatActor(grant: OwnerGrant): string {
    return `${grant.actor.namespace}:${grant.actor.principalId}`;
}

export function SessionRemotePermissionGrantsView(props: Readonly<{
    sessionId: string;
    serverId: string | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const routeKey = `${props.sessionId}\u0000${props.serverId ?? ''}`;
    const routeKeyRef = React.useRef(routeKey);
    routeKeyRef.current = routeKey;
    const listGenerationRef = React.useRef(0);
    const revokeGenerationRef = React.useRef(0);
    const listAbortControllerRef = React.useRef<AbortController | null>(null);
    const revokeAbortControllerRef = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<GrantListState>({ kind: 'loading' });
    const [operationIssue, setOperationIssue] = React.useState<OperationIssue | null>(null);
    const [revokingGrantId, setRevokingGrantId] = React.useState<string | null>(null);

    const executor = React.useMemo(() => createDefaultActionExecutor({
        resolveServerIdForSessionId: (sessionId) => sessionId === props.sessionId ? props.serverId : null,
    }), [props.serverId, props.sessionId]);

    const load = React.useCallback(async (cursor: string | null, append: boolean) => {
        const requestRouteKey = routeKey;
        const requestGeneration = ++listGenerationRef.current;
        listAbortControllerRef.current?.abort();
        const abortController = new AbortController();
        listAbortControllerRef.current = abortController;
        const isCurrent = () => (
            listGenerationRef.current === requestGeneration
            && routeKeyRef.current === requestRouteKey
            && !abortController.signal.aborted
        );

        if (append) {
            setState((previous) => previous.kind === 'ready'
                ? { ...previous, loadingMore: true }
                : previous);
        } else {
            setOperationIssue(null);
            setState({ kind: 'loading' });
        }

        try {
            const result = await executor.execute(
                'session.permission.remote.grants.list',
                {
                    sessionId: props.sessionId,
                    limit: REMOTE_PERMISSION_GRANTS_PAGE_SIZE,
                    ...(cursor ? { cursor } : {}),
                },
                {
                    surface: 'ui',
                    defaultSessionId: props.sessionId,
                    serverId: props.serverId,
                    signal: abortController.signal,
                },
            );
            if (!isCurrent()) return;

            if (!result.ok) {
                if (append) {
                    setOperationIssue('loadMore');
                    setState((previous) => previous.kind === 'ready'
                        ? { ...previous, loadingMore: false }
                        : previous);
                } else {
                    setState({ kind: 'unavailable', code: result.errorCode ?? 'action_failed' });
                }
                return;
            }

            const parsed = SessionPermissionRemoteGrantsListOutputV1Schema.safeParse(result.result);
            if (!parsed.success || !parsed.data.grants.every(isOwnerGrant)) {
                if (append) {
                    setOperationIssue('loadMore');
                    setState((previous) => previous.kind === 'ready'
                        ? { ...previous, loadingMore: false }
                        : previous);
                } else {
                    setState({ kind: 'unavailable', code: 'invalid_grant_projection' });
                }
                return;
            }

            const grants = parsed.data.grants;
            setOperationIssue(null);
            setState((previous) => ({
                kind: 'ready',
                grants: append && previous.kind === 'ready'
                    ? mergeGrants(previous.grants, grants)
                    : grants,
                nextCursor: parsed.data.nextCursor,
                loadingMore: false,
            }));
        } catch {
            if (!isCurrent()) return;
            if (append) {
                setOperationIssue('loadMore');
                setState((previous) => previous.kind === 'ready'
                    ? { ...previous, loadingMore: false }
                    : previous);
            } else {
                setState({ kind: 'unavailable', code: 'action_failed' });
            }
        }
    }, [executor, props.serverId, props.sessionId, routeKey]);

    React.useEffect(() => {
        void load(null, false);
    }, [load]);

    React.useEffect(() => {
        return () => {
            listGenerationRef.current += 1;
            revokeGenerationRef.current += 1;
            listAbortControllerRef.current?.abort();
            revokeAbortControllerRef.current?.abort();
        };
    }, [routeKey]);

    const revoke = React.useCallback(async (grant: OwnerGrant) => {
        const confirmed = await Modal.confirm(
            t('sessionRemotePermissionGrants.revokeConfirmTitle'),
            t('sessionRemotePermissionGrants.revokeConfirmBody', { identifier: grant.projection.rule.identifier }),
            {
                confirmText: t('sessionRemotePermissionGrants.revoke'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        if (routeKeyRef.current !== routeKey) return;

        const requestRouteKey = routeKey;
        const requestGeneration = ++revokeGenerationRef.current;
        revokeAbortControllerRef.current?.abort();
        const abortController = new AbortController();
        revokeAbortControllerRef.current = abortController;
        const isCurrent = () => (
            revokeGenerationRef.current === requestGeneration
            && routeKeyRef.current === requestRouteKey
            && !abortController.signal.aborted
        );

        setOperationIssue(null);
        setRevokingGrantId(grant.grantId);
        try {
            const result = await executor.execute(
                'session.permission.remote.grants.revoke',
                {
                    sessionId: props.sessionId,
                    requestId: grant.requestId,
                    grantId: grant.grantId,
                },
                {
                    surface: 'ui',
                    defaultSessionId: props.sessionId,
                    serverId: props.serverId,
                    signal: abortController.signal,
                },
            );
            if (!isCurrent()) return;

            if (!result.ok) {
                setOperationIssue('revoke');
                return;
            }

            const parsed = SessionPermissionRemoteGrantRevokeOutputV1Schema.safeParse(result.result);
            if (!parsed.success || parsed.data.status === 'rejected' || parsed.data.grantId !== grant.grantId) {
                setOperationIssue('revoke');
                return;
            }

            await load(null, false);
        } catch {
            if (isCurrent()) {
                setOperationIssue('revoke');
            }
        } finally {
            if (isCurrent()) {
                setRevokingGrantId(null);
            }
        }
    }, [executor, load, props.serverId, props.sessionId, routeKey]);

    const loadMore = React.useCallback(() => {
        if (state.kind !== 'ready' || !state.nextCursor || state.loadingMore) return;
        void load(state.nextCursor, true);
    }, [load, state]);

    if (state.kind === 'loading') {
        return (
            <SurfaceStateCard
                testID="session-remote-permission-grants-loading"
                kind="loading"
                title={t('sessionRemotePermissionGrants.loadingTitle')}
                reason={t('sessionRemotePermissionGrants.loadingReason')}
                accessibilitySemantics="status"
            />
        );
    }

    if (state.kind === 'unavailable') {
        return (
            <SurfaceStateCard
                testID="session-remote-permission-grants-unavailable"
                kind="unavailable"
                title={t('sessionRemotePermissionGrants.unavailableTitle')}
                reason={t('sessionRemotePermissionGrants.unavailableReason')}
                diagnosticCode={state.code}
                action={{ label: t('sessionRemotePermissionGrants.retry'), onPress: () => load(null, false) }}
                accessibilitySemantics="alert"
            />
        );
    }

    if (state.grants.length === 0 && !state.nextCursor) {
        return (
            <SurfaceStateCard
                testID="session-remote-permission-grants-empty"
                kind="empty"
                title={t('sessionRemotePermissionGrants.emptyTitle')}
                reason={t('sessionRemotePermissionGrants.emptyReason')}
                action={{ label: t('sessionRemotePermissionGrants.retry'), onPress: () => load(null, false) }}
                accessibilitySemantics="status"
            />
        );
    }

    return (
        <ItemList>
            <ItemGroup title={t('sessionRemotePermissionGrants.listTitle')}>
                {state.grants.map((grant) => {
                    const revoked = grant.revokedAtMs != null;
                    const grantTestId = `session-remote-permission-grant-${grant.grantId}`;
                    return (
                        <React.Fragment key={grant.grantId}>
                            <Item
                                testID={grantTestId}
                                title={grant.projection.rule.identifier}
                                subtitle={revoked
                                    ? t('sessionRemotePermissionGrants.grantRevoked', { actor: formatActor(grant) })
                                    : t('sessionRemotePermissionGrants.grantActive', { actor: formatActor(grant) })}
                                detail={t('sessionRemotePermissionGrants.grantDetail', {
                                    grantId: grant.grantId,
                                    sourceRef: grant.sourceRef,
                                    sourceRevisionOrEpoch: grant.sourceRevisionOrEpoch,
                                })}
                                icon={<Icon
                                    name={revoked ? 'x-circle' : 'shield-check'}
                                    size={29}
                                    color={revoked ? theme.colors.text.secondary : theme.colors.accent.blue}
                                />}
                                mode="info"
                                copy={grant.grantId}
                            />
                            {revoked ? null : (
                                <Item
                                    testID={`${grantTestId}-revoke`}
                                    title={t('sessionRemotePermissionGrants.revoke')}
                                    subtitle={revokingGrantId === grant.grantId
                                        ? t('sessionRemotePermissionGrants.revoking')
                                        : undefined}
                                    icon={<Icon name="x-circle" size={29} color={theme.colors.state.danger.foreground} />}
                                    onPress={() => { void revoke(grant); }}
                                    disabled={revokingGrantId !== null}
                                    loading={revokingGrantId === grant.grantId}
                                    destructive
                                />
                            )}
                        </React.Fragment>
                    );
                })}
            </ItemGroup>

            {operationIssue ? (
                <ItemGroup title={t('sessionRemotePermissionGrants.revokeFailedTitle')}>
                    <Item
                        testID="session-remote-permission-grants-operation-error"
                        title={t('sessionRemotePermissionGrants.revokeFailedTitle')}
                        subtitle={operationIssue === 'loadMore'
                            ? t('sessionRemotePermissionGrants.loadMoreFailedReason')
                            : t('sessionRemotePermissionGrants.revokeFailedReason')}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.state.danger.foreground} />}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            {state.nextCursor ? (
                <ItemGroup title="">
                    <Item
                        testID="session-remote-permission-grants-load-more"
                        title={state.loadingMore
                            ? t('sessionRemotePermissionGrants.loadingMore')
                            : t('sessionRemotePermissionGrants.loadMore')}
                        icon={<Icon name="arrow-circle-down" size={29} color={theme.colors.accent.blue} />}
                        onPress={loadMore}
                        disabled={state.loadingMore}
                        loading={state.loadingMore}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}
