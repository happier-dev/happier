import * as React from 'react';
import { supportsMachineSessionFollowWakeOnHumanChangeV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { SessionFollowSourceKeyPreparationWaitingReasonV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowSourceModeV1, SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { Pressable, View } from 'react-native';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    listSessionFollowSources,
    removeSessionFollowSource,
    setSessionFollowSource,
} from '@/sync/api/session/sessionFollowSourcesApi';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { useServerScopedMachine, useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import {
    isServerReachabilityNetworkAllowed,
    subscribeServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import {
    refineSessionFollowSourceStateWithPreparationReason,
    resolveSessionFollowSourceRuntimeState,
    sessionFollowSourceRuntimeStateLabel,
} from './sessionFollowSourcePresentation';
import { openSessionFollowSourcePicker } from './openSessionFollowDestinationPicker';
import {
    prepareSessionFollowSourceKey,
} from './prepareSessionFollowSourceKey';
import {
    createIdleSessionFollowMutationIntent,
    reduceSessionFollowMutationIntent,
    type SessionFollowMutationIntentEvent,
    type SessionFollowMutationIntentState,
} from './sessionFollowMutationIntent';

function sourcePreparationKey(preparationTargetKey: string, sourceSessionId: string): string {
    return `${preparationTargetKey}\u0000${sourceSessionId}`;
}

type SessionFollowSourceMutationRequest = Readonly<{
    targetKey: string;
    sourceSessionId: string;
}>;

/**
 * The exact operation a failed Stop-following or mode change owes: reloading the list is not a
 * retry of either, and a successful reload must not make the error disappear while the relation
 * is still active and still supplying updates.
 */
type SessionFollowSourceIntent =
    | Readonly<{ kind: 'remove'; sourceSessionId: string }>
    | Readonly<{ kind: 'mode'; sourceSessionId: string; mode: SessionFollowSourceModeV1 }>;

function reduceSourceMutation(
    state: SessionFollowMutationIntentState<SessionFollowSourceIntent>,
    event: SessionFollowMutationIntentEvent<SessionFollowSourceIntent>,
): SessionFollowMutationIntentState<SessionFollowSourceIntent> {
    return reduceSessionFollowMutationIntent(state, event);
}

export function SessionFollowSourcesEditor(props: Readonly<{
    destination: Session;
    serverId: string | null;
    destinationMachineId: string | null;
}>) {
    const online = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeServerReachabilityNetworkAllowed(() => listener()), []),
        isServerReachabilityNetworkAllowed,
        isServerReachabilityNetworkAllowed,
    );
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.serverId });
    const rowsByServerId = useSessionListRowsByServerId();
    const [sources, setSources] = React.useState<readonly SessionFollowSourceV1[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [savingId, setSavingId] = React.useState<string | null>(null);
    const [expandedSourceKey, setExpandedSourceKey] = React.useState<string | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [mutation, dispatchMutation] = React.useReducer(
        reduceSourceMutation,
        createIdleSessionFollowMutationIntent<SessionFollowSourceIntent>(),
    );
    const [preparedSourceKeys, setPreparedSourceKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const [preparingFlightKeys, setPreparingFlightKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const [preparationWaitingReasons, setPreparationWaitingReasons] = React.useState<ReadonlyMap<string, SessionFollowSourceKeyPreparationWaitingReasonV1>>(() => new Map());
    const addSourceRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    const requestVersionRef = React.useRef(0);
    const targetKey = `${props.serverId ?? ''}\u0000${props.destination.id}`;
    const preparationTargetKey = `${targetKey}\u0000${props.destinationMachineId ?? ''}`;
    const targetKeyRef = React.useRef(targetKey);
    const preparationTargetKeyRef = React.useRef(preparationTargetKey);
    const activeMutationRequestRef = React.useRef<SessionFollowSourceMutationRequest | null>(null);
    const preparationInFlightRef = React.useRef(new Set<string>());
    const committedSourceIdsRef = React.useRef<ReadonlySet<string>>(new Set());
    const edgeVersionBySourceIdRef = React.useRef(new Map<string, number>());

    const refresh = React.useCallback(async () => {
        if (!enabled || !props.serverId) return;
        const requestVersion = ++requestVersionRef.current;
        setLoading(true);
        const result = await listSessionFollowSources({ serverId: props.serverId, sessionId: props.destination.id });
        if (requestVersion !== requestVersionRef.current || targetKeyRef.current !== targetKey) return;
        if (result.kind === 'ok') {
            const committedSourceIds = new Set(result.value.sources.map((source) => source.sourceSessionId));
            const previousCommittedSourceIds = committedSourceIdsRef.current;
            for (const sourceSessionId of new Set([
                ...previousCommittedSourceIds,
                ...committedSourceIds,
            ])) {
                if (previousCommittedSourceIds.has(sourceSessionId) !== committedSourceIds.has(sourceSessionId)) {
                    edgeVersionBySourceIdRef.current.set(
                        sourceSessionId,
                        (edgeVersionBySourceIdRef.current.get(sourceSessionId) ?? 0) + 1,
                    );
                }
            }
            committedSourceIdsRef.current = committedSourceIds;
            const committedPreparationKeys = new Set([...committedSourceIds].map((sourceSessionId) => (
                sourcePreparationKey(preparationTargetKeyRef.current, sourceSessionId)
            )));
            setSources(result.value.sources);
            setPreparedSourceKeys((current) => {
                const next = new Set([...current].filter((key) => committedPreparationKeys.has(key)));
                return next.size === current.size ? current : next;
            });
            setPreparationWaitingReasons((current) => {
                const next = new Map([...current].filter(([key]) => committedPreparationKeys.has(key)));
                return next.size === current.size ? current : next;
            });
            setFailed(false);
            dispatchMutation({ kind: 'refreshed' });
        } else {
            setFailed(true);
        }
        setLoading(false);
    }, [enabled, props.destination.id, props.serverId, targetKey]);

    React.useEffect(() => {
        if (targetKeyRef.current !== targetKey) {
            targetKeyRef.current = targetKey;
            setSources([]);
            setFailed(false);
            dispatchMutation({ kind: 'abandoned' });
            setSavingId(null);
            activeMutationRequestRef.current = null;
            setPreparedSourceKeys(new Set());
            setPreparingFlightKeys(new Set());
            setPreparationWaitingReasons(new Map());
            committedSourceIdsRef.current = new Set();
            edgeVersionBySourceIdRef.current = new Map();
        }
        void refresh();
        return () => {
            requestVersionRef.current += 1;
        };
    }, [refresh, targetKey]);

    React.useEffect(() => () => {
        activeMutationRequestRef.current = null;
    }, []);

    React.useEffect(() => {
        if (preparationTargetKeyRef.current === preparationTargetKey) return;
        preparationTargetKeyRef.current = preparationTargetKey;
        activeMutationRequestRef.current = null;
        setSavingId(null);
        setPreparedSourceKeys(new Set());
        setPreparingFlightKeys(new Set());
        setPreparationWaitingReasons(new Map());
    }, [preparationTargetKey]);

    React.useEffect(() => {
        const serverId = props.serverId;
        if (!enabled || !serverId) return;
        return subscribeHomeAccountChange((event) => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
            if (
                event.entityIds
                && !event.entityIds.includes(props.destination.id)
                && !event.entityIds.some((sessionId) => committedSourceIdsRef.current.has(sessionId))
            ) return;
            void refresh();
        });
    }, [enabled, props.destination.id, props.serverId, refresh]);

    const remove = React.useCallback(async (sourceSessionId: string) => {
        if (!online || !props.serverId || savingId) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceSessionId,
        };
        activeMutationRequestRef.current = request;
        setSavingId(sourceSessionId);
        dispatchMutation({ kind: 'started', intent: { kind: 'remove', sourceSessionId } });
        const input = { serverId: props.serverId, destinationSessionId: props.destination.id, sourceSessionId };
        const result = await removeSessionFollowSource(input);
        if (
            preparationTargetKeyRef.current !== request.targetKey
            || activeMutationRequestRef.current !== request
        ) return;
        if (result.kind === 'ok') {
            dispatchMutation({ kind: 'succeeded' });
            await refresh();
            if (
                preparationTargetKeyRef.current !== request.targetKey
                || activeMutationRequestRef.current !== request
            ) return;
            addSourceRef.current?.focus();
        }
        else dispatchMutation({ kind: 'failed', error: true });
        activeMutationRequestRef.current = null;
        setSavingId(null);
    }, [online, preparationTargetKey, props.destination.id, props.serverId, refresh, savingId]);

    const updateMode = React.useCallback(async (sourceSessionId: string, mode: SessionFollowSourceModeV1) => {
        if (!online || !props.serverId || savingId) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceSessionId,
        };
        activeMutationRequestRef.current = request;
        setSavingId(sourceSessionId);
        dispatchMutation({ kind: 'started', intent: { kind: 'mode', sourceSessionId, mode } });
        const result = await setSessionFollowSource({
            serverId: props.serverId,
            destinationSessionId: props.destination.id,
            sourceSessionId,
            mode,
        });
        if (
            preparationTargetKeyRef.current !== request.targetKey
            || activeMutationRequestRef.current !== request
        ) return;
        if (result.kind === 'ok') {
            dispatchMutation({ kind: 'succeeded' });
            await refresh();
            if (
                preparationTargetKeyRef.current !== request.targetKey
                || activeMutationRequestRef.current !== request
            ) return;
        }
        else dispatchMutation({ kind: 'failed', error: true });
        activeMutationRequestRef.current = null;
        setSavingId(null);
    }, [online, preparationTargetKey, props.destination.id, props.serverId, refresh, savingId]);

    const serverId = props.serverId;
    const homeSessions = Object.values(readSessionListRowsForServerId(rowsByServerId, serverId ?? '') ?? {});
    // Exact qualified Machine currentness belongs to the canonical scoped
    // selector. The picker-oriented Machine list intentionally filters records
    // and is not an authority for an already-bound destination Runner.
    const destinationMachine = useServerScopedMachine(serverId, props.destinationMachineId ?? '');

    const prepareSource = React.useCallback(async (sourceSessionId: string) => {
        if (!online || !props.serverId) return;
        const requestTargetKey = targetKey;
        const requestPreparationTargetKey = preparationTargetKey;
        const requestEdgeVersion = edgeVersionBySourceIdRef.current.get(sourceSessionId) ?? 0;
        const preparationSourceKey = sourcePreparationKey(requestPreparationTargetKey, sourceSessionId);
        const flightKey = `${preparationSourceKey}\u0000${requestEdgeVersion}`;
        if (preparationInFlightRef.current.has(flightKey)) return;
        preparationInFlightRef.current.add(flightKey);
        setPreparingFlightKeys((current) => new Set(current).add(flightKey));
        const result = await prepareSessionFollowSourceKey({
            serverId: props.serverId, sourceSessionId, destinationSessionId: props.destination.id,
        }).catch(() => ({ kind: 'waiting', reason: 'runner_unreachable' } as const));
        preparationInFlightRef.current.delete(flightKey);
        if (
            targetKeyRef.current !== requestTargetKey
            || preparationTargetKeyRef.current !== requestPreparationTargetKey
        ) return;
        setPreparingFlightKeys((current) => {
            const next = new Set(current);
            next.delete(flightKey);
            return next;
        });
        // A receiver result cannot establish readiness for an edge that was
        // removed while the request was in flight. The server remains the
        // pairwise authority; this prevents stale UI-lifetime state from
        // suppressing preparation if the same relation is later re-created.
        if (!committedSourceIdsRef.current.has(sourceSessionId)
            || edgeVersionBySourceIdRef.current.get(sourceSessionId) !== requestEdgeVersion) return;
        setPreparedSourceKeys((current) => {
            const next = new Set(current);
            if (result.kind === 'prepared' || result.kind === 'not_needed') next.add(preparationSourceKey);
            else next.delete(preparationSourceKey);
            return next;
        });
        setPreparationWaitingReasons((current) => {
            const next = new Map(current);
            if (result.kind === 'waiting') next.set(preparationSourceKey, result.reason);
            else next.delete(preparationSourceKey);
            return next;
        });
    }, [online, preparationTargetKey, props.destination.id, props.serverId, targetKey]);

    const preparationReadinessSignature = [
        targetKey,
        online ? 'online' : 'offline',
        props.destinationMachineId ?? '',
        destinationMachine?.active === true ? 'active' : 'inactive',
        String(destinationMachine?.activeAt ?? ''),
        String(destinationMachine?.operationProtocolCapabilitiesRevision ?? ''),
        ...sources.map((source) => {
            const session = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
            return `${source.sourceSessionId}:${source.deliveryState}:${session?.encryptionMode ?? 'unknown'}`;
        }),
    ].join('\u0000');
    const lastPreparationReadinessSignatureRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!online || lastPreparationReadinessSignatureRef.current === preparationReadinessSignature) return;
        lastPreparationReadinessSignatureRef.current = preparationReadinessSignature;
        for (const source of sources) {
            const sourceSession = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
            const runtimeState = resolveSessionFollowSourceRuntimeState({
                deliveryState: source.deliveryState,
                machine: destinationMachine,
                sourceEncryptionMode: sourceSession?.encryptionMode ?? null,
                preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
                hasPendingUpdates: source.hasPendingUpdates,
                mode: source.mode,
            });
            const flightKey = `${sourcePreparationKey(preparationTargetKey, source.sourceSessionId)}\u0000${edgeVersionBySourceIdRef.current.get(source.sourceSessionId) ?? 0}`;
            if (runtimeState === 'waiting_for_source_key' && !preparingFlightKeys.has(flightKey)) {
                void prepareSource(source.sourceSessionId);
            }
        }
    }, [destinationMachine, homeSessions, online, preparationReadinessSignature, preparationTargetKey, prepareSource, preparedSourceKeys, preparingFlightKeys, sources]);

    if (!enabled || !serverId) return null;

    return <>
        <ItemGroup title={t('session.follow.sources.title')}>
            {!online ? <Item
                testID="session-follow-sources-offline"
                title={t('session.follow.offline')}
                accessibilityLiveRegion="polite"
                titleLines={0}
                showChevron={false}
                mode="info"
            /> : null}
            {loading && sources.length === 0 ? <Item title={t('common.loading')} loading showChevron={false} mode="info" /> : null}
            {!loading && sources.length === 0 && !failed ? <Item title={t('common.none')} showChevron={false} mode="info" /> : null}
            {sources.map((source) => {
                const session = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
                const runtimeState = resolveSessionFollowSourceRuntimeState({
                    deliveryState: source.deliveryState,
                    machine: destinationMachine,
                    sourceEncryptionMode: session?.encryptionMode ?? null,
                    preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
                    hasPendingUpdates: source.hasPendingUpdates,
                    mode: source.mode,
                });
                const sourceTitle = session ? getSessionName(session, serverId) : source.sourceSessionId;
                const preparationSourceKey = sourcePreparationKey(preparationTargetKey, source.sourceSessionId);
                const currentFlightKey = `${preparationSourceKey}\u0000${edgeVersionBySourceIdRef.current.get(source.sourceSessionId) ?? 0}`;
                const preparing = preparingFlightKeys.has(currentFlightKey);
                const preparationWaitingReason = preparationWaitingReasons.get(preparationSourceKey);
                const presentedRuntimeState = refineSessionFollowSourceStateWithPreparationReason(runtimeState, preparationWaitingReason);
                // An unavailable SOURCE key can still become available (the Session is unlocked
                // in this client), so it keeps its retry; only an unavailable Runner key cannot.
                const canRetryPreparation = presentedRuntimeState === 'waiting_for_source_key'
                    || presentedRuntimeState === 'source_key_unavailable'
                    || preparationWaitingReason === 'runner_unreachable';
                const canChooseWake = supportsMachineSessionFollowWakeOnHumanChangeV1(
                    destinationMachine?.operationProtocolCapabilities,
                );
                const canChangeMode = canChooseWake || source.mode === 'wake_on_human_change';
                const modeLabel = source.mode === 'wake_on_human_change'
                    ? t('session.follow.sources.wakeOnHumanChange')
                    : t('session.follow.sources.nextTurn');
                const statusText = presentedRuntimeState === 'eligible'
                    ? modeLabel
                    : sessionFollowSourceRuntimeStateLabel(presentedRuntimeState);
                const expandedKey = `${targetKey}\u0000${source.sourceSessionId}`;
                return <ExpandableItem
                    key={source.sourceSessionId}
                    expanded={canChangeMode && expandedSourceKey === expandedKey}
                    onExpandedChange={(expanded) => setExpandedSourceKey(expanded ? expandedKey : null)}
                    header={({ headerProps }) => <Item
                        {...(canChangeMode ? headerProps : {})}
                        accessibilityExpanded={canChangeMode ? expandedSourceKey === expandedKey : undefined}
                        testID={`session-follow-source-${source.sourceSessionId}`}
                        accessibilityLabel={[
                            t('session.follow.sources.row', { title: sourceTitle }),
                            statusText,
                        ].join('. ')}
                        title={t('session.follow.sources.row', { title: sourceTitle })}
                        titleLines={0}
                        subtitle={preparing ? t('session.follow.sources.sourceKeyPreparing') : statusText}
                        subtitleLines={0}
                        accessoryLayout="adaptive"
                        disabled={!online || savingId !== null || preparing}
                        rightElementOutsidePressable
                        keepChevronWithRightElement={canChangeMode}
                        rightElement={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {canRetryPreparation ? <RoundButton
                                testID={`session-follow-source-${source.sourceSessionId}-retry`}
                                title={t('common.retry')}
                                size="small"
                                display="secondary"
                                accessibilityLabel={`${t('common.retry')}. ${t('session.follow.sources.row', { title: sourceTitle })}`}
                                disabled={!online || savingId !== null || preparing}
                                onPress={() => { void prepareSource(source.sourceSessionId); }}
                            /> : null}
                            <IconButton
                                testID={`session-follow-source-${source.sourceSessionId}-remove`}
                                iconName="trash"
                                accessibilityLabel={t('session.follow.sources.stopForSource', { title: sourceTitle })}
                                disabled={!online || savingId !== null}
                                onPress={() => { void remove(source.sourceSessionId); }}
                            />
                        </View>}
                    />}
                >
                    <ItemGroup accessibilityRole="radiogroup" accessibilityLabel={t('session.follow.sources.row', { title: sourceTitle })}>
                        {(['next_turn', 'wake_on_human_change'] as const).map((mode) => <Item
                            key={mode}
                            testID={`session-follow-source-${source.sourceSessionId}-mode-${mode}`}
                            title={t(mode === 'next_turn' ? 'session.follow.sources.nextTurn' : 'session.follow.sources.wakeOnHumanChange')}
                            subtitle={mode === 'next_turn' ? t('session.follow.sources.includeNextTurn') : undefined}
                            titleLines={0}
                            accessibilityRole="radio"
                            selected={source.mode === mode}
                            disabled={!online || savingId !== null || (mode === 'wake_on_human_change' && !canChooseWake)}
                            showChevron={false}
                            onPress={() => {
                                if (source.mode !== mode) void updateMode(source.sourceSessionId, mode);
                            }}
                            rightElement={source.mode === mode ? <Icon name="check" size={20} /> : undefined}
                        />)}
                    </ItemGroup>
                </ExpandableItem>;
            })}
            {failed || mutation.error !== null ? <Item
                testID="session-follow-sources-error"
                title={t('errors.unknownError')}
                detail={t('common.retry')}
                accessibilityLiveRegion="polite"
                // Retry re-executes the exact operation that failed; only a failed list load
                // retries by loading the list again.
                onPress={() => {
                    const intent = mutation.failed;
                    if (!intent) { void refresh(); return; }
                    if (intent.kind === 'remove') { void remove(intent.sourceSessionId); return; }
                    void updateMode(intent.sourceSessionId, intent.mode);
                }}
            /> : null}
        </ItemGroup>
        <ItemGroup title={t('common.add')}>
            <Item
                pressableRef={addSourceRef}
                testID="session-follow-source-add"
                title={t('session.follow.sources.addSource')}
                subtitle={t('session.follow.sources.includeNextTurn')}
                disabled={!online || savingId !== null}
                onPress={() => openSessionFollowSourcePicker({
                    serverId,
                    sessionId: props.destination.id,
                }, addSourceRef, async (change) => {
                    if (change?.preparation === 'prepared') {
                        const preparationSourceKey = sourcePreparationKey(preparationTargetKey, change.sourceSessionId);
                        setPreparedSourceKeys((current) => new Set(current).add(preparationSourceKey));
                        setPreparationWaitingReasons((current) => {
                            const next = new Map(current);
                            next.delete(preparationSourceKey);
                            return next;
                        });
                    } else if (change?.preparation === 'waiting') {
                        const preparationSourceKey = sourcePreparationKey(preparationTargetKey, change.sourceSessionId);
                        setPreparedSourceKeys((current) => {
                            const next = new Set(current);
                            next.delete(preparationSourceKey);
                            return next;
                        });
                        // Store the reason the preparation actually returned. Inventing
                        // `source_key_unavailable` here made an unreachable Runner and an
                        // unsupported destination read as a source-key problem.
                        setPreparationWaitingReasons((current) => {
                            const next = new Map(current);
                            if (change.reason === undefined) next.delete(preparationSourceKey);
                            else next.set(preparationSourceKey, change.reason);
                            return next;
                        });
                    }
                    await refresh();
                })}
            />
        </ItemGroup>
    </>;
}
