import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import * as React from 'react';
import { View } from 'react-native';

import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SELECTION_LIST_SKELETON_ROW_SHAPE } from '@/components/ui/selectionList/_constants';
import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { setSessionFollowSource } from '@/sync/api/session/sessionFollowSourcesApi';
import { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useServerScopedMachine, useSessionListRowRenderablesForItems } from '@/sync/domains/state/storage';
import {
    isServerReachabilityNetworkAllowed,
    subscribeServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachineActivity } from '@/hooks/machine/useMachineActivity';

import {
    resolveSessionFollowDestinationTargets,
    resolveSessionFollowSourceTargets,
} from './resolveSessionFollowDestinationTargets';
import {
    buildSessionFollowPickerContextTitle,
    resolveSessionFollowPickerPresentation,
} from './sessionFollowPickerPresentation';
import {
    refineSessionFollowSourceStateWithPreparationReason,
    sessionFollowSourceRuntimeStateLabel,
} from './sessionFollowSourcePresentation';
import { prepareSessionFollowSourceKey, type SessionFollowSourceKeyPreparationResult } from './prepareSessionFollowSourceKey';
import type { SessionFollowSourcePreparationChange } from './openSessionFollowDestinationPicker';

export type SessionFollowDestinationPickerModalProps = CustomModalInjectedProps & (
    | Readonly<{ source: SessionAddress; destination?: never; onChanged?: (change?: SessionFollowSourcePreparationChange) => void | Promise<void> }>
    | Readonly<{ destination: SessionAddress; source?: never; onChanged?: (change?: SessionFollowSourcePreparationChange) => void | Promise<void> }>
);

const SESSION_FOLLOW_PICKER_QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: true,
    scope: 'all_accessible',
    attention: 'any',
    audiences: [],
    tagIds: [],
    limit: 200,
};

function readSessionItems(
    itemsByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>,
    serverId: string,
): Extract<SessionListIndexItem, { type: 'session' }>[] {
    return (itemsByServerId[serverId] ?? [])
        .filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
}

export const SessionFollowDestinationPickerModal = React.memo(function SessionFollowDestinationPickerModal(
    props: SessionFollowDestinationPickerModalProps,
) {
    const fixedAddress: SessionAddress = props.source ?? props.destination;
    const isSessionVisible = useSessionRecordingVisibility();
    const choosingDestination = props.source !== undefined;
    const title = choosingDestination
        ? t('session.follow.sources.chooseDestinationTitle')
        : t('session.follow.sources.chooseSourceTitle');
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'lg' as const },
    }), [title]));

    const queryHomes = React.useMemo(() => [{
        serverId: fixedAddress.serverId,
        query: SESSION_FOLLOW_PICKER_QUERY,
    }], [fixedAddress.serverId]);
    const querySource = useSessionListQuerySourceState({ enabled: true, homes: queryHomes });
    const itemsByServerId = querySource.byServerId;
    const items = React.useMemo(
        () => readSessionItems(itemsByServerId, fixedAddress.serverId),
        [fixedAddress.serverId, itemsByServerId],
    );
    const renderables = useSessionListRowRenderablesForItems(items);
    const online = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeServerReachabilityNetworkAllowed(() => listener()), []),
        isServerReachabilityNetworkAllowed,
        isServerReachabilityNetworkAllowed,
    );
    const candidates = React.useMemo(() => items.flatMap((item) => {
        const session = renderables.get(sessionAddressKey({
            serverId: fixedAddress.serverId,
            sessionId: item.sessionId,
        }));
        return session ? [{ ...session, serverId: fixedAddress.serverId }] : [];
    }), [fixedAddress.serverId, items, renderables]);
    const destinations = React.useMemo(() => {
        const eligible = choosingDestination
            ? resolveSessionFollowDestinationTargets({ source: fixedAddress, sessions: candidates })
            : resolveSessionFollowSourceTargets({ destination: fixedAddress, sessions: candidates });
        const eligibleIds = new Set(eligible.map((candidate) => candidate.id));
        return candidates.filter((candidate) => eligibleIds.has(candidate.id)
            && isSessionVisible({ serverId: fixedAddress.serverId, sessionId: candidate.id }));
    }, [candidates, choosingDestination, fixedAddress, isSessionVisible]);
    const fixedSession = candidates.find((candidate) => candidate.id === fixedAddress.sessionId) ?? null;
    const homeProfile = getServerProfileById(fixedAddress.serverId);
    const contextTitle = buildSessionFollowPickerContextTitle({
        actionTitle: title,
        sessionTitle: fixedSession && isSessionVisible(fixedAddress) ? getSessionName(fixedSession) : null,
        homeName: resolveHomeDisplayLabel(homeProfile, fixedAddress.serverId),
    });
    const [saving, setSaving] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const [committedRelation, setCommittedRelation] = React.useState<Readonly<{
        sourceSessionId: string;
        destinationSessionId: string;
    }> | null>(null);
    const [preparation, setPreparation] = React.useState<'queued' | 'preparing' | SessionFollowSourceKeyPreparationResult | null>(null);
    const destinationForPreparation = committedRelation
        ? candidates.find((candidate) => candidate.id === committedRelation.destinationSessionId) ?? null
        : null;
    const destinationMachineId = destinationForPreparation
        ? resolveSessionMachineId(destinationForPreparation.metadata)
        : null;
    const preparationRequestRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => {
        preparationRequestRef.current?.abort();
        preparationRequestRef.current = null;
        setPreparation(current => current === 'preparing' ? 'queued' : current);
    }, [fixedAddress.serverId, fixedAddress.sessionId, destinationMachineId]);
    const destinationMachine = useServerScopedMachine(fixedAddress.serverId, destinationMachineId ?? '');
    const destinationMachinePresence = useMachinePresenceSummary(fixedAddress.serverId, destinationMachineId);
    const preparationNeedsActivity = committedRelation !== null && (preparation === null
        || typeof preparation === 'string' || preparation.kind === 'waiting');
    // A heartbeat is readiness evidence only for an unsettled key recovery.
    // Keep the same subscription while preparing so completion cannot itself
    // manufacture a changed readiness signature and another attempt.
    const destinationActivity = useMachineActivity(preparationNeedsActivity ? destinationMachine : null);
    const retryReadinessSignature = committedRelation ? [
        online ? 'online' : 'offline',
        destinationMachinePresence.reachability,
        destinationMachineId ?? '',
        destinationMachine?.active === true ? 'active' : 'inactive',
        String(destinationActivity?.activeAt ?? ''),
        String(destinationMachine?.operationProtocolCapabilitiesRevision ?? ''),
    ].join('\u0000') : '';
    const retryReadinessSignatureRef = React.useRef(retryReadinessSignature);
    retryReadinessSignatureRef.current = retryReadinessSignature;
    const lastAttemptReadinessSignatureRef = React.useRef<string | null>(null);
    const queryPresentation = React.useMemo(() => resolveSessionListQueryPresentation({
        selectedServerIds: [fixedAddress.serverId],
        statesByServerId: querySource.statesByServerId,
        coverageComplete: querySource.coverageComplete,
        retainedRowCount: destinations.length,
    }), [destinations.length, fixedAddress.serverId, querySource.coverageComplete, querySource.statesByServerId]);
    const pickerPresentation = resolveSessionFollowPickerPresentation(queryPresentation, destinations.length, online);
    // The first page is still loading: reserve the rows instead of an empty list plus a status line.
    const firstPageLoading = queryPresentation.kind === 'initial_loading' && destinations.length === 0 && online;
    const statusKey = firstPageLoading ? null : pickerPresentation.statusKey;

    const loadNext = querySource.loadNext;
    React.useEffect(() => {
        if (queryPresentation.kind !== 'ready' || queryPresentation.complete) return;
        void loadNext();
    }, [loadNext, queryPresentation]);

    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => destinations.map((session) => ({
        id: session.id,
        testID: `session-follow-destination-option-${session.id}`,
        label: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        disabled: saving || committedRelation !== null || !pickerPresentation.canSelect,
    })), [committedRelation, destinations, pickerPresentation.canSelect, saving]);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'session-follow-destination-root',
        title: contextTitle,
        inputPlaceholder: t('transcript.selection.sendTo.searchPlaceholder'),
        emptyStateLabel: t('transcript.selection.sendTo.noResults'),
        sections: [{ kind: 'static', id: 'sessions', options, virtualization: 'auto' }],
    }), [contextTitle, options]);

    const prepareCommittedRelation = React.useCallback(async (relation: NonNullable<typeof committedRelation>) => {
        preparationRequestRef.current?.abort();
        const controller = new AbortController();
        preparationRequestRef.current = controller;
        setPreparation('preparing');
        const result = await prepareSessionFollowSourceKey({ serverId: fixedAddress.serverId, ...relation, signal: controller.signal })
            .catch(() => ({ kind: 'waiting', reason: 'runner_unreachable' } as const));
        if (controller.signal.aborted || preparationRequestRef.current !== controller) return;
        preparationRequestRef.current = null;
        lastAttemptReadinessSignatureRef.current = retryReadinessSignatureRef.current;
        setPreparation(result);
        if (result.kind === 'prepared' || result.kind === 'not_needed') {
            await props.onChanged?.({ ...relation, preparation: 'prepared' });
            props.onClose();
            return;
        }
        await props.onChanged?.({
            ...relation,
            preparation: 'waiting',
            ...(result.kind === 'waiting' ? { reason: result.reason } : {}),
        });
    }, [fixedAddress.serverId, props]);

    React.useEffect(() => {
        if (!committedRelation || !preparation || preparation === 'preparing') return;
        if (preparation !== 'queued' && preparation.kind !== 'waiting') return;
        // The Action already made the first attempt. Capture its readiness so
        // only a later readiness change or the existing Retry prepares again.
        if (lastAttemptReadinessSignatureRef.current === null && preparation !== 'queued') {
            lastAttemptReadinessSignatureRef.current = retryReadinessSignature;
            return;
        }
        if (!online) return;
        if (lastAttemptReadinessSignatureRef.current === retryReadinessSignature) return;
        void prepareCommittedRelation(committedRelation);
    }, [committedRelation, online, preparation, prepareCommittedRelation, retryReadinessSignature]);

    return <View testID="session-follow-destination-picker" style={{ flex: 1, minHeight: 0 }}>
        {failed ? <Text accessibilityLiveRegion="polite">{t('errors.unknownError')}</Text> : null}
        {preparation === 'queued' || preparation === 'preparing' ? <Text
            testID="session-follow-source-key-preparing"
            accessibilityLiveRegion="polite"
        >{t('session.follow.sources.sourceKeyPreparing')}</Text> : null}
        {preparation && typeof preparation !== 'string' && preparation.kind === 'waiting' ? <Item
            testID="session-follow-source-key-waiting"
            // The same refinement owner the sources editor uses, so the two surfaces
            // cannot disagree about what a reason means. An outdated destination
            // runtime is the version gap the source list reports, and a destination
            // holding no usable key material is not a wait at all — repeating the
            // preparation against either cannot succeed, and the readiness effect
            // already re-attempts once the Machine advertises new capabilities, so
            // neither state offers a Retry the person could act on.
            title={sessionFollowSourceRuntimeStateLabel(
                refineSessionFollowSourceStateWithPreparationReason('waiting_for_source_key', preparation.reason),
            )}
            accessibilityLiveRegion="polite"
            {...(preparation.reason === 'unsupported' || preparation.reason === 'runner_key_unavailable'
                ? { mode: 'info' as const } : {
                detail: t('common.retry'),
                disabled: saving,
                onPress: () => { if (committedRelation) void prepareCommittedRelation(committedRelation); },
            })}
        /> : null}
        {statusKey && pickerPresentation.canRetryQuery ? <Item
            testID="session-follow-picker-currentness"
            title={t(statusKey)}
            titleLines={0}
            // Discovery only advances itself while the query is ready, so a failed or partial
            // corpus is retried through the shared query owner — the search input and any
            // retained choice stay exactly as they are.
            detail={t('common.retry')}
            disabled={saving}
            onPress={() => { void querySource.retry(); }}
            accessibilityLiveRegion="polite"
        /> : statusKey ? <Text
            testID="session-follow-picker-currentness"
            accessibilityLiveRegion="polite"
        >{t(statusKey)}</Text> : null}
        <SelectionList
            testID="session-follow-destination-list"
            rootStep={rootStep}
            onSelect={(destinationSessionId) => {
                if (!isServerReachabilityNetworkAllowed() || saving || committedRelation !== null
                    || !pickerPresentation.canSelect || !destinations.some((candidate) => candidate.id === destinationSessionId)) return;
                setSaving(true);
                setFailed(false);
                const relation = {
                    serverId: fixedAddress.serverId,
                    sourceSessionId: choosingDestination ? fixedAddress.sessionId : destinationSessionId,
                    destinationSessionId: choosingDestination ? destinationSessionId : fixedAddress.sessionId,
                    policy: { preset: 'important' as const },
                };
                void setSessionFollowSource(relation).then(async (result) => {
                    if (result.kind === 'ok' || result.committedSource) {
                        const committed = {
                            sourceSessionId: relation.sourceSessionId,
                            destinationSessionId: relation.destinationSessionId,
                        };
                        setCommittedRelation(committed);
                        setSaving(false);
                        if (result.preparation) {
                            setPreparation(result.preparation);
                            await props.onChanged?.({ ...committed, preparation: 'waiting', reason: result.preparation.reason });
                        } else {
                            setPreparation({ kind: 'prepared' });
                            await props.onChanged?.({ ...committed, preparation: 'prepared' });
                            props.onClose();
                        }
                        return;
                    }
                    setSaving(false);
                    setFailed(true);
                });
            }}
            onRequestClose={props.onClose}
            contentState={firstPageLoading ? (
                <View
                    testID="session-follow-destination-loading"
                    accessibilityRole="progressbar"
                    accessibilityLabel={t('sessionsList.queryInitialLoadingTitle')}
                >
                    <SkeletonRows rows={4} {...SELECTION_LIST_SKELETON_ROW_SHAPE} />
                </View>
            ) : undefined}
            autoFocusInputOnWeb
            keyboardHintsEnabled
            heightBehavior="content"
            showsVerticalScrollIndicator
        />
    </View>;
});
