import * as React from 'react';
import { editFollowPolicyV1, projectFollowPolicyEditorV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionFollowSourceKeyPreparationWaitingReasonV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { followDeliveryMuteScopeKeyV1, type FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { FollowSourceRelationV1, SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { useWorkflowRunRows } from '@/sync/store/hooks';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useIsTablet } from '@/utils/platform/responsive';
import {
    removeSessionFollowSource,
    setSessionFollowSource,
} from '@/sync/api/session/sessionFollowSourcesApi';
import {
    includeProjectInFollowRule,
    undoFollowRuleProjectEdit,
    writeSessionFollowRuleDefinition,
    type FollowRuleProjectEditUndo,
} from '@/sync/api/session/sessionFollowRuleEdits';
import { SessionListStoredFilterEditor } from '@/components/sessions/shell/search/SessionListStoredFilterEditor';
import { describeSessionListFilterFacts } from '@/components/sessions/shell/search/sessionListFilterSummary';
import { useProjectPickerOptions } from '@/components/projects/useProjectPickerOptions';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { useActiveServerAccountScope, useServerScopedMachine, useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useMachineActivity } from '@/hooks/machine/useMachineActivity';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import {
    isServerReachabilityNetworkAllowed,
    subscribeServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

import {
    refineSessionFollowSourceStateWithPreparationReason,
    resolveSessionFollowSourceRuntimeState,
    sessionFollowSourceRuntimeStateLabel,
} from './sessionFollowSourcePresentation';
import { FollowEditorPanel } from './FollowEditorPanel';
import { FollowPolicyEditorBinding, FollowPolicySection } from './FollowPolicyEditorBinding';
import { FollowSessionMark } from './FollowSessionMark';
import { describeSessionFollowLevel } from './sessionFollowLevelCopy';
import { describeFollowRuleMatchCount, useFollowRuleMatchCounts } from './followRuleMatchCounts';
import { useSessionFollowing, type SessionFollowingController, type SessionFollowingProjection } from './useSessionFollowing';
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
    sourceKey: string;
}>;

const EMPTY_SOURCES: readonly FollowSourceRelationV1[] = Object.freeze([]);
type FollowingRule = SessionFollowingProjection['rules'][number];
const EMPTY_RULES: readonly FollowingRule[] = Object.freeze([]);

function ruleKey(rule: FollowingRule): string {
    return followSourceKey({ kind: 'rule', ruleId: rule.ruleId });
}

/**
 * One row's identity across every source kind: a Session source keeps its id (the phone route's `source` and the
 * row test ids), the other kinds (Discussion, Execution Run, Workflow Run) a kind-qualified key of their exact ref.
 */
export function followSourceKey(source: FollowSourceRefV1): string {
    switch (source.kind) {
        case 'session': return source.sessionId;
        case 'discussion': return `discussion:${source.discussionId}`;
        case 'execution_run': return followDeliveryMuteScopeKeyV1({ kind: 'source', source });
        case 'workflow_run': return `workflow_run:${source.runId}`;
        case 'rule': return `rule:${source.ruleId}`;
    }
}

function readFollowSourceRef(source: FollowSourceRelationV1): FollowSourceRefV1 {
    return 'sourceSessionId' in source ? { kind: 'session', sessionId: source.sourceSessionId } : source.source;
}

/** A Session source is addressed by its id; every other kind by its exact ref. */
function sourcePair(source: FollowSourceRefV1) {
    return source.kind === 'session' ? { sourceSessionId: source.sessionId } : { source };
}

function isSessionSource(source: FollowSourceRelationV1): source is SessionFollowSourceV1 {
    return 'sourceSessionId' in source;
}

/**
 * The exact operation a failed Stop-following or policy change owes: reloading the list is not a
 * retry of either, and a successful reload must not make the error disappear while the relation
 * is still active and still supplying updates.
 */
type SessionFollowSourceIntent =
    | Readonly<{ kind: 'remove'; source: FollowSourceRefV1 }>
    | Readonly<{ kind: 'policy'; source: FollowSourceRefV1; policy: FollowPolicyV1 }>
    | Readonly<{ kind: 'rule'; ruleId: string; write: FollowRuleWrite }>;

/** One edit to a rule's filter, each written whole through the rule writer at a read version. */
type FollowRuleWrite =
    | Readonly<{ kind: 'filter'; filter: SessionListFilterV1 }>
    | Readonly<{ kind: 'include'; project: QualifiedProjectKeyV1; name: string }>
    | Readonly<{ kind: 'undo'; undo: FollowRuleProjectEditUndo }>;

function reduceSourceMutation(
    state: SessionFollowMutationIntentState<SessionFollowSourceIntent>,
    event: SessionFollowMutationIntentEvent<SessionFollowSourceIntent>,
): SessionFollowMutationIntentState<SessionFollowSourceIntent> {
    return reduceSessionFollowMutationIntent(state, event);
}

type FollowSourcePanelParts = Readonly<{
    title: string;
    subtitle: string;
    mark: React.ReactNode;
    body: React.ReactNode;
    footer: React.ReactNode;
}>;

/**
 * A source row's anchor: the row sits in a view that anchors its own Follow panel, and hands the panel's
 * focus-return ref to the row's pressable.
 */
function SourceRowAnchor(props: Readonly<{
    row: (triggerRef: React.RefObject<React.ComponentRef<typeof Pressable> | null>) => React.ReactNode;
    panel: ((refs: Readonly<{
        anchorRef: React.RefObject<View | null>;
        triggerRef: React.RefObject<React.ComponentRef<typeof Pressable> | null>;
    }>) => React.ReactNode) | null;
}>) {
    const anchorRef = React.useRef<View>(null);
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    return <>
        <View ref={anchorRef} collapsable={false}>{props.row(triggerRef)}</View>
        {props.panel?.({ anchorRef, triggerRef })}
    </>;
}

/**
 * The Sessions this one follows (lab P1-P, P2-S). Inside a page (`ListPresentationProvider value="page"`) it is two
 * grouped sections, "Following" and "Add". Anywhere else it is one flat section of a side pane (People): a heading
 * with its count and "+", then flat rows, drawn like the pane's Discussions. The pane mounts it with no list
 * presentation around it.
 *
 * A row opens that source's Follow panel (title, how much it hears, Stop updates · Done): anchored to the row on
 * a wide window, a pushed page on a phone. `page` is that pushed page: the same editor, controller and writers
 * place one source's panel through its `frame` instead of the list. `sheet` is the list inside People's Following
 * sheet (C1 R12): the sheet names the direction, so the rows and Add stand without a heading, and on a wide window
 * the sheet steps to a row's panel in place (`onOpenSource`) rather than floating a second panel over itself.
 */
export function SessionFollowSourcesEditor(props: Readonly<{
    /** The Session that follows: its identity is all the list needs, so it shows before the Session's own snapshot lands. */
    destination: Readonly<{ id: string }>;
    serverId: string | null;
    destinationMachineId: string | null;
    /** The host's own Following census for this destination, when it also summarizes it (People's header line). */
    following?: SessionFollowingController;
    page?: Readonly<{
        /** The source's row key (`followSourceKey`): a Session source's id, or another kind's qualified key. */
        sourceKey: string;
        frame(parts: FollowSourcePanelParts): React.ReactNode;
        onClose(): void;
    }>;
    sheet?: Readonly<{ onOpenSource?: (sourceKey: string) => void }>;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const anchored = useIsTablet();
    const listPresentation = useListPresentation();
    // The sheet lists sources the way the pane does (marks, names, what each wakes), in its grouped rows.
    const pane = listPresentation !== 'page' || props.sheet !== undefined;
    const paneSection = pane && props.sheet === undefined;
    const rowLook = paneSection ? { density: 'compact' as const, showDivider: false } : {};
    const online = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeServerReachabilityNetworkAllowed(() => listener()), []),
        isServerReachabilityNetworkAllowed,
        isServerReachabilityNetworkAllowed,
    );
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.serverId });
    const rowsByServerId = useSessionListRowsByServerId();
    const activeScope = useActiveServerAccountScope();
    const currentScope = selectActiveServerAccountScopeForServer(activeScope, props.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(currentScope ? null : props.serverId);
    const accountScope = currentScope ?? (binding?.isCurrent() ? binding.scope : null);
    const reachabilityRevision = useMachineReachabilityRevision();
    // One census per destination: a host that already reads it passes it in, and this read stays idle.
    const ownFollowing = useSessionFollowing(props.serverId && !props.following ? { serverId: props.serverId, sessionId: props.destination.id } : null, enabled && !props.following);
    const following = props.following ?? ownFollowing;
    const sources = following.projection?.sources ?? EMPTY_SOURCES;
    // A rule follows whatever matches it when each event happens; it is a row like a source, never enrolled sessions.
    const rules = following.projection?.rules ?? EMPTY_RULES;
    const projects = useProjectPickerOptions();
    const ruleCountInputs = React.useMemo(() => rules.map((rule) => ({ key: ruleKey(rule), filter: rule.definition.filter })), [rules]);
    const ruleCounts = useFollowRuleMatchCounts(enabled ? props.serverId : null, props.destination.id, ruleCountInputs, following.ruleInputs);
    const { loading, refresh } = following;
    const [savingId, setSavingId] = React.useState<string | null>(null);
    const [openSourceId, setOpenSourceId] = React.useState<string | null>(null);
    // A rule panel's "Which sessions" step holds its draft until Save; the receipt keeps the last way back (Undo).
    const [ruleFilterDraft, setRuleFilterDraft] = React.useState<Readonly<{ ruleId: string; filter: SessionListFilterV1 }> | null>(null);
    const [ruleReceipt, setRuleReceipt] = React.useState<Readonly<{ ruleId: string; label: string; undo: FollowRuleProjectEditUndo }> | null>(null);
    const draftCountInputs = React.useMemo(() => (ruleFilterDraft ? [{ key: 'draft', filter: ruleFilterDraft.filter }] : []), [ruleFilterDraft]);
    const draftCount = useFollowRuleMatchCounts(enabled ? props.serverId : null, props.destination.id, draftCountInputs, following.ruleInputs).draft;
    const failed = following.error !== null;
    const [mutation, dispatchMutation] = React.useReducer(
        reduceSourceMutation,
        createIdleSessionFollowMutationIntent<SessionFollowSourceIntent>(),
    );
    const [preparedSourceKeys, setPreparedSourceKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const [preparingFlightKeys, setPreparingFlightKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const [preparationWaitingReasons, setPreparationWaitingReasons] = React.useState<ReadonlyMap<string, SessionFollowSourceKeyPreparationWaitingReasonV1>>(() => new Map());
    const addSourceRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    // The pane's "+" is an IconButton, which hands out its control through a callback ref.
    const paneAddRef = React.useRef<Readonly<{ focus: () => void }> | null>(null);
    const targetKey = `${props.serverId ?? ''}\u0000${accountScope?.accountId ?? ''}\u0000${props.destination.id}`;
    const preparationTargetKey = `${targetKey}\u0000${props.destinationMachineId ?? ''}`;
    const targetKeyRef = React.useRef(targetKey);
    const preparationTargetKeyRef = React.useRef(preparationTargetKey);
    const activeMutationRequestRef = React.useRef<SessionFollowSourceMutationRequest | null>(null);
    const preparationInFlightRef = React.useRef(new Map<string, { sourceSessionId: string; controller: AbortController }>());
    const committedSourceIdsRef = React.useRef<ReadonlySet<string>>(new Set());
    const edgeVersionBySourceIdRef = React.useRef(new Map<string, number>());

    React.useEffect(() => {
        if (following.projection) {
            // Every source kind is a row; source-key preparation and wake filtering concern Session sources only.
            const sessionSources = following.projection.sources.filter(isSessionSource);
            const committedSourceIds = new Set(sessionSources.map((source) => source.sourceSessionId));
            const previousCommittedSourceIds = committedSourceIdsRef.current;
            for (const sourceSessionId of new Set([
                ...previousCommittedSourceIds,
                ...committedSourceIds,
            ])) {
                if (previousCommittedSourceIds.has(sourceSessionId) !== committedSourceIds.has(sourceSessionId)) {
                    for (const [key, request] of preparationInFlightRef.current) {
                        if (request.sourceSessionId === sourceSessionId) {
                            request.controller.abort();
                            preparationInFlightRef.current.delete(key);
                        }
                    }
                    edgeVersionBySourceIdRef.current.set(
                        sourceSessionId,
                        (edgeVersionBySourceIdRef.current.get(sourceSessionId) ?? 0) + 1,
                    );
                }
            }
            committedSourceIdsRef.current = committedSourceIds;
            setPreparingFlightKeys(current => new Set([...current].filter(key => preparationInFlightRef.current.has(key))));
            const committedPreparationKeys = new Set([...committedSourceIds].map((sourceSessionId) => (
                sourcePreparationKey(preparationTargetKeyRef.current, sourceSessionId)
            )));
            setPreparedSourceKeys((current) => {
                const next = new Set([...current].filter((key) => committedPreparationKeys.has(key)));
                return next.size === current.size ? current : next;
            });
            setPreparationWaitingReasons((current) => {
                const next = new Map([...current].filter(([key]) => committedPreparationKeys.has(key)));
                return next.size === current.size ? current : next;
            });
            dispatchMutation({ kind: 'refreshed' });
        }
    }, [following.projection]);

    React.useEffect(() => {
        if (targetKeyRef.current !== targetKey) {
            targetKeyRef.current = targetKey;
            dispatchMutation({ kind: 'abandoned' });
            setSavingId(null);
            activeMutationRequestRef.current = null;
            setPreparedSourceKeys(new Set());
            setPreparingFlightKeys(new Set());
            setPreparationWaitingReasons(new Map());
            committedSourceIdsRef.current = new Set();
            edgeVersionBySourceIdRef.current = new Map();
        }
    }, [targetKey]);

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

    React.useEffect(() => () => {
        for (const request of preparationInFlightRef.current.values()) request.controller.abort();
        preparationInFlightRef.current.clear();
    }, [preparationTargetKey]);

    const remove = React.useCallback(async (source: FollowSourceRefV1) => {
        if (!online || !props.serverId || savingId) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceKey: followSourceKey(source),
        };
        activeMutationRequestRef.current = request;
        setSavingId(request.sourceKey);
        dispatchMutation({ kind: 'started', intent: { kind: 'remove', source } });
        const rule = source.kind === 'rule' ? rules.find((candidate) => candidate.ruleId === source.ruleId) : undefined;
        const result = await removeSessionFollowSource({ serverId: props.serverId, destinationSessionId: props.destination.id,
            ...sourcePair(source), ...(rule ? { expectedVersion: rule.version } : {}),
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
            // Its panel has nothing left to edit: close it, or leave the page that held it.
            setOpenSourceId(null);
            if (props.page) props.page.onClose();
            else (addSourceRef.current ?? paneAddRef.current)?.focus();
        }
        else dispatchMutation({ kind: 'failed', error: true });
        activeMutationRequestRef.current = null;
        setSavingId(null);
    }, [online, preparationTargetKey, props.destination.id, props.page, props.serverId, refresh, rules, savingId]);

    const updatePolicy = React.useCallback(async (source: FollowSourceRefV1, policy: FollowPolicyV1) => {
        if (!online || !props.serverId || savingId) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceKey: followSourceKey(source),
        };
        activeMutationRequestRef.current = request;
        setSavingId(request.sourceKey);
        dispatchMutation({ kind: 'started', intent: { kind: 'policy', source, policy } });
        // A rule's policy is part of its definition, written whole at the version this list read.
        const rule = source.kind === 'rule' ? rules.find((candidate) => candidate.ruleId === source.ruleId) : undefined;
        const result = rule
            ? await writeSessionFollowRuleDefinition(props.serverId, { ...rule, definition: { ...rule.definition, policy } }, rule.version)
            : await setSessionFollowSource({
                serverId: props.serverId,
                destinationSessionId: props.destination.id,
                ...sourcePair(source),
                policy,
            });
        if (
            preparationTargetKeyRef.current !== request.targetKey
            || activeMutationRequestRef.current !== request
        ) return;
        if (result.kind === 'ok' || ('committedSource' in result && result.committedSource)) {
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
    }, [online, preparationTargetKey, props.destination.id, props.serverId, refresh, rules, savingId]);

    const writeRule = React.useCallback(async (ruleId: string, write: FollowRuleWrite) => {
        const rule = rules.find((candidate) => candidate.ruleId === ruleId);
        if (!online || !props.serverId || savingId || !rule) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceKey: ruleKey(rule),
        };
        activeMutationRequestRef.current = request;
        setSavingId(request.sourceKey);
        dispatchMutation({ kind: 'started', intent: { kind: 'rule', ruleId, write } });
        let receipt: Readonly<{ ruleId: string; label: string; undo: FollowRuleProjectEditUndo }> | null = null;
        let ok: boolean;
        if (write.kind === 'filter') {
            const result = await writeSessionFollowRuleDefinition(props.serverId, { ...rule, definition: { ...rule.definition, filter: write.filter } }, rule.version);
            ok = result.kind === 'ok';
        } else if (write.kind === 'include') {
            const result = await includeProjectInFollowRule({ serverId: props.serverId, rule, project: write.project });
            ok = result.kind === 'ok';
            if (result.kind === 'ok') receipt = { ruleId, label: t('session.follow.sources.ruleIncludedAgain', { name: write.name }), undo: result.value.undo };
        } else {
            ok = (await undoFollowRuleProjectEdit(write.undo)).kind === 'ok';
        }
        if (
            preparationTargetKeyRef.current !== request.targetKey
            || activeMutationRequestRef.current !== request
        ) return;
        if (ok) {
            dispatchMutation({ kind: 'succeeded' });
            if (write.kind === 'filter') setRuleFilterDraft(null);
            setRuleReceipt(receipt);
            await refresh();
            if (
                preparationTargetKeyRef.current !== request.targetKey
                || activeMutationRequestRef.current !== request
            ) return;
        }
        else dispatchMutation({ kind: 'failed', error: true });
        activeMutationRequestRef.current = null;
        setSavingId(null);
    }, [online, preparationTargetKey, props.serverId, refresh, rules, savingId]);

    const serverId = props.serverId;
    const homeSessions = Object.values(readSessionListRowsForServerId(rowsByServerId, serverId ?? '') ?? {});
    // Exact qualified Machine currentness belongs to the canonical scoped
    // selector. The picker-oriented Machine list intentionally filters records
    // and is not an authority for an already-bound destination Runner.
    const destinationMachine = useServerScopedMachine(serverId, props.destinationMachineId ?? '');
    const nowMs = useMachinePresenceNowMs(destinationMachine ? [destinationMachine] : []);
    const destinationPresence = destinationMachine
        ? resolveMachinePickerPresence(destinationMachine, nowMs, accountScope).status
        : null;
    const canPrepareSource = accountScope !== null && destinationMachine !== null
        && destinationMachine.availability?.kind !== 'locked'
        && destinationPresence !== 'revoked' && destinationPresence !== 'replaced';
    const destinationReachable = destinationMachine !== null && isMachineReachable(accountScope, destinationMachine, nowMs);
    const preparationNeedsActivity = enabled && online && canPrepareSource && sources.some((source) => {
        if (!isSessionSource(source)) return false;
        const session = homeSessions.find(candidate => candidate.id === source.sourceSessionId);
        return resolveSessionFollowSourceRuntimeState({ accountScope, nowMs, machine: destinationMachine,
            deliveryState: source.deliveryState, sourceEncryptionMode: session?.encryptionMode ?? null,
            preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
            hasPendingUpdates: source.hasPendingUpdates,
        }) === 'waiting_for_source_key';
    });
    // Retain this exact clock during a pending attempt as well as after a
    // waiting result. Settling the attempt must not reset its readiness key.
    const destinationActivity = useMachineActivity(preparationNeedsActivity ? destinationMachine : null);

    const prepareSource = React.useCallback(async (sourceSessionId: string, intent?: 'retry') => {
        if (!canPrepareSource || !props.serverId) return;
        const requestTargetKey = targetKey;
        const requestPreparationTargetKey = preparationTargetKey;
        const requestEdgeVersion = edgeVersionBySourceIdRef.current.get(sourceSessionId) ?? 0;
        const preparationSourceKey = sourcePreparationKey(requestPreparationTargetKey, sourceSessionId);
        const flightKey = `${preparationSourceKey}\u0000${requestEdgeVersion}`;
        if (preparationInFlightRef.current.has(flightKey)) return;
        const request = { sourceSessionId, controller: new AbortController() };
        preparationInFlightRef.current.set(flightKey, request);
        setPreparingFlightKeys((current) => new Set(current).add(flightKey));
        const result = await prepareSessionFollowSourceKey({
            serverId: props.serverId, sourceSessionId, destinationSessionId: props.destination.id,
            ...(intent ? { intent } : {}),
            signal: request.controller.signal,
        }).catch(() => ({ kind: 'waiting', reason: 'runner_unreachable' } as const));
        if (preparationInFlightRef.current.get(flightKey) !== request) return;
        preparationInFlightRef.current.delete(flightKey);
        if (
            targetKeyRef.current !== requestTargetKey
            || preparationTargetKeyRef.current !== requestPreparationTargetKey
            || request.controller.signal.aborted
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
    }, [canPrepareSource, preparationTargetKey, props.destination.id, props.serverId, targetKey]);

    const preparationReadinessSignature = [
        targetKey,
        online ? 'online' : 'offline',
        destinationReachable ? 'reachable' : 'unreachable',
        props.destinationMachineId ?? '',
        destinationMachine?.active === true ? 'active' : 'inactive',
        String(destinationActivity?.activeAt ?? ''),
        String(destinationMachine?.operationProtocolCapabilitiesRevision ?? ''),
        ...sources.filter(isSessionSource).map((source) => {
            const session = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
            return `${source.sourceSessionId}:${source.deliveryState}:${session?.encryptionMode ?? 'unknown'}`;
        }),
    ].join('\u0000');
    const lastPreparationReadinessSignatureRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (lastPreparationReadinessSignatureRef.current === preparationReadinessSignature) return;
        lastPreparationReadinessSignatureRef.current = preparationReadinessSignature;
        if (!online || !destinationReachable) return;
        for (const source of sources.filter(isSessionSource)) {
            const sourceSession = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
            const runtimeState = resolveSessionFollowSourceRuntimeState({
                accountScope,
                nowMs,
                deliveryState: source.deliveryState,
                machine: destinationMachine,
                sourceEncryptionMode: sourceSession?.encryptionMode ?? null,
                preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
                hasPendingUpdates: source.hasPendingUpdates,
            });
            const flightKey = `${sourcePreparationKey(preparationTargetKey, source.sourceSessionId)}\u0000${edgeVersionBySourceIdRef.current.get(source.sourceSessionId) ?? 0}`;
            if (runtimeState === 'waiting_for_source_key' && !preparingFlightKeys.has(flightKey)) {
                void prepareSource(source.sourceSessionId);
            }
        }
    }, [destinationMachine, destinationReachable, homeSessions, online, preparationReadinessSignature, preparationTargetKey, prepareSource, preparedSourceKeys, preparingFlightKeys, sources, accountScope, nowMs, reachabilityRevision]);

    // Non-Session sources are named by their own owners' projections: a Discussion's title, a Workflow Run's
    // Account-private name, and an Execution Run by the Session it runs in.
    const discussionAddresses = React.useMemo(() => sources.flatMap((source) => (
        !isSessionSource(source) && source.source.kind === 'discussion' ? [{ serverId, discussionId: source.source.discussionId }] : []
    )), [serverId, sources]);
    const discussionTitles = useDiscussionTitleProjections(discussionAddresses);
    const workflowRunIds = React.useMemo(() => sources.flatMap((source) => (
        !isSessionSource(source) && source.source.kind === 'workflow_run' ? [source.source.runId] : []
    )), [sources]);
    const workflowRuns = useWorkflowRunRows(workflowRunIds, accountScope);

    if (!enabled || !serverId) return null;

    const addSource = () => openSessionFollowSourcePicker({
        serverId,
        sessionId: props.destination.id,
    }, paneSection ? paneAddRef : addSourceRef, async (change) => {
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
    });

    const sessionTitle = (sessionId: string) => {
        const session = homeSessions.find((candidate) => candidate.id === sessionId);
        return { session, title: session ? getSessionName(session, serverId) : sessionId };
    };
    const sourceIdentity = (source: FollowSourceRelationV1): Readonly<{
        key: string; ref: FollowSourceRefV1; sourceTitle: string; mark: React.ReactNode; icon: IconName;
        session: ReturnType<typeof sessionTitle>['session'];
    }> => {
        const ref = readFollowSourceRef(source);
        const key = followSourceKey(ref);
        const glyph = (name: IconName) => <Icon name={name} size={18} color={theme.colors.text.secondary} />;
        switch (ref.kind) {
            case 'session': {
                const { session, title } = sessionTitle(ref.sessionId);
                return { key, ref, session, sourceTitle: title, icon: 'stack',
                    mark: <FollowSessionMark session={session ?? null} serverId={serverId} /> };
            }
            case 'discussion': {
                const index = discussionAddresses.findIndex((address) => address.discussionId === ref.discussionId);
                return { key, ref, session: undefined, icon: 'chats-circle', mark: glyph('chats-circle'),
                    sourceTitle: discussionTitles[index] ?? t('session.follow.sources.kindDiscussion') };
            }
            case 'execution_run':
                return { key, ref, session: undefined, icon: 'play', mark: glyph('play'),
                    sourceTitle: t('session.follow.sources.executionRun', { title: 'sessionId' in ref ? sessionTitle(ref.sessionId).title : ref.machineId }) };
            case 'workflow_run': {
                const run = workflowRuns.find((row) => row.id === ref.runId);
                return { key, ref, session: undefined, icon: 'tree-structure', mark: glyph('tree-structure'),
                    sourceTitle: run ? formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(run.metadata)) : t('session.follow.sources.kindWorkflowRun') };
            }
            case 'rule':
                return { key, ref, session: undefined, icon: 'funnel-simple', mark: glyph('funnel-simple'), sourceTitle: ref.ruleId };
        }
    };
    const ruleTitle = (rule: FollowingRule) => {
        const facts = describeSessionListFilterFacts(rule.definition.filter, projects);
        return facts.length > 0
            ? t('session.follow.sources.ruleMatching', { facts: facts.join(' · ') })
            : t('session.follow.sources.ruleEvery');
    };
    const policyDisabled = !online || savingId !== null;
    // A panel is open while its source is still listed; a mutation error belongs to that panel then, not to the list.
    const panelOpen = anchored && (sources.some((source) => followSourceKey(readFollowSourceRef(source)) === openSourceId)
        || rules.some((rule) => ruleKey(rule) === openSourceId));
    const closePanel = () => {
        setOpenSourceId(null);
        setRuleFilterDraft(null);
        setRuleReceipt(null);
        props.page?.onClose();
    };
    // Retry re-executes the exact operation that failed; only a failed list load retries by loading the list again.
    const retryFailed = () => {
        const intent = mutation.failed;
        if (!intent) { void refresh(); return; }
        if (intent.kind === 'remove') { void remove(intent.source); return; }
        if (intent.kind === 'rule') { void writeRule(intent.ruleId, intent.write); return; }
        void updatePolicy(intent.source, intent.policy);
    };
    const errorRow = (look: typeof rowLook | Record<string, never>) => <Item
        {...look}
        testID="session-follow-sources-error"
        title={t('errors.unknownError')}
        detail={t('common.retry')}
        accessibilityLiveRegion="polite"
        onPress={retryFailed}
    />;

    // One source's panel (lab P2-S): who it hears from and how much, Stop updates quiet at the left, Done.
    const panelPartsFor = (source: FollowSourceRelationV1): FollowSourcePanelParts => {
        const { key, ref, sourceTitle, mark } = sourceIdentity(source);
        return panelParts({ key, ref, sourceTitle, mark, title: t('session.follow.sources.row', { title: sourceTitle }), policy: source.policy });
    };
    // A rule's panel is the same one: which sessions it follows (and the projects it leaves to others, each with its
    // way back), how much it hears, Stop updates · Done. "Which sessions" opens the Sessions list's own filter editor
    // in place, as a step of this panel (lab P3-R); Save writes the rule whole at the version this list read.
    const rulePanelParts = (rule: FollowingRule): FollowSourcePanelParts => {
        const key = ruleKey(rule);
        const title = ruleTitle(rule);
        const mark = <Icon name="funnel-simple" size={18} color={theme.colors.text.secondary} />;
        const level = t(`session.follow.policy.${rule.definition.policy.preset}`);
        const errorGroup = mutation.error !== null ? <ItemGroup>{errorRow({})}</ItemGroup> : null;
        const draft = ruleFilterDraft?.ruleId === rule.ruleId ? ruleFilterDraft.filter : null;
        if (draft) {
            return {
                title,
                subtitle: t('session.follow.sources.ruleWhich'),
                mark,
                body: <>
                    {errorGroup}
                    <Item
                        testID={`session-follow-source-${key}-filter-back`}
                        showChevron={false}
                        showDivider={false}
                        icon={<Icon name="caret-left" size={18} color={theme.colors.text.secondary} />}
                        title={t('common.back')}
                        onPress={() => setRuleFilterDraft(null)}
                    />
                    <SessionListStoredFilterEditor
                        serverId={serverId}
                        filter={draft}
                        onFilterChange={(filter) => setRuleFilterDraft({ ruleId: rule.ruleId, filter })}
                        onReset={() => setRuleFilterDraft({ ruleId: rule.ruleId, filter: rule.definition.filter })}
                        summary={describeFollowRuleMatchCount(draftCount, level)}
                        doneLabel={t('common.save')}
                        canDone={!policyDisabled}
                        onDone={() => { void writeRule(rule.ruleId, { kind: 'filter', filter: draft }); }}
                    />
                </>,
                // The editor's own foot carries the live count, Reset and Save.
                footer: null,
            };
        }
        const parts = panelParts({ key, ref: { kind: 'rule', ruleId: rule.ruleId }, sourceTitle: title, title, mark,
            policy: rule.definition.policy, showError: false });
        const leftOut = rule.definition.filter.projects?.exclude ?? [];
        const receipt = ruleReceipt?.ruleId === rule.ruleId ? ruleReceipt : null;
        const projectName = (project: QualifiedProjectKeyV1) => projects.find((candidate) => (
            candidate.serverId === project.serverId && candidate.projectKey === project.projectKey
        ))?.label ?? project.projectKey;
        return {
            ...parts,
            body: <>
                {errorGroup}
                {/* Its own block above the level, with the rhythm the level editor's sections keep between them. */}
                <ItemGroup style={styles.ruleScope}>
                    <Item
                        testID={`session-follow-source-${key}-filter`}
                        title={t('session.follow.sources.ruleWhich')}
                        subtitle={describeFollowRuleMatchCount(ruleCounts[key], level)}
                        disabled={policyDisabled}
                        onPress={() => { setRuleReceipt(null); setRuleFilterDraft({ ruleId: rule.ruleId, filter: rule.definition.filter }); }}
                    />
                    {leftOut.map((project) => {
                        const name = projectName(project);
                        return <Item
                            key={`${project.serverId}\u0000${project.projectKey}`}
                            testID={`session-follow-source-${key}-left-out-${project.projectKey}`}
                            icon={<Icon name="minus-circle" size={18} color={theme.colors.text.secondary} />}
                            title={t('session.follow.sources.ruleLeftOut', { name })}
                            titleLines={0}
                            showChevron={false}
                            rightElement={<RoundButton
                                testID={`session-follow-source-${key}-left-out-${project.projectKey}-include`}
                                title={t('session.follow.sources.ruleIncludeAgain')}
                                size="small"
                                display="secondary"
                                disabled={policyDisabled}
                                onPress={() => { void writeRule(rule.ruleId, { kind: 'include', project, name }); }}
                            />}
                        />;
                    })}
                    {receipt ? <Item
                        testID={`session-follow-source-${key}-left-out-receipt`}
                        icon={<Icon name="check" size={18} color={theme.colors.text.secondary} />}
                        title={receipt.label}
                        titleLines={0}
                        showChevron={false}
                        accessibilityLiveRegion="polite"
                        rightElement={<RoundButton
                            testID={`session-follow-source-${key}-left-out-undo`}
                            title={t('common.undo')}
                            size="small"
                            display="secondary"
                            disabled={policyDisabled}
                            onPress={() => { void writeRule(rule.ruleId, { kind: 'undo', undo: receipt.undo }); }}
                        />}
                    /> : null}
                </ItemGroup>
                {parts.body}
            </>,
        };
    };
    function panelParts(input: Readonly<{
        key: string; ref: FollowSourceRefV1; sourceTitle: string; title: string; mark: React.ReactNode; policy: FollowPolicyV1;
        /** A host that leads with its own sections places the error row above them instead. */
        showError?: boolean;
    }>): FollowSourcePanelParts {
        const { key, ref, sourceTitle, mark } = input;
        const draft = mutation.pending ?? mutation.failed;
        const policy = draft?.kind === 'policy' && followSourceKey(draft.source) === key
            ? draft.policy : input.policy;
        return {
            title: input.title,
            subtitle: t('session.follow.sources.panelSubtitle'),
            mark,
            body: <>
                {input.showError !== false && mutation.error !== null ? <ItemGroup>{errorRow({})}</ItemGroup> : null}
                <FollowPolicySection>
                    <FollowPolicyEditorBinding
                        testID={`session-follow-source-${key}-policy`}
                        receiver="session"
                        model={projectFollowPolicyEditorV1(policy)}
                        disabled={policyDisabled}
                        onEditPolicy={(edit) => { void updatePolicy(ref, editFollowPolicyV1(policy, edit)); }}
                    />
                </FollowPolicySection>
            </>,
            footer: <SectionButtonRow
                trailing={<RoundButton testID={`session-follow-source-${key}-done`} title={t('common.done')} onPress={closePanel} />}
            >
                <RoundButton
                    testID={`session-follow-source-${key}-remove`}
                    display="inverted"
                    title={t('session.follow.sources.stop')}
                    accessibilityLabel={t('session.follow.sources.stopForSource', { title: sourceTitle })}
                    disabled={policyDisabled}
                    onPress={() => { void remove(ref); }}
                />
            </SectionButtonRow>,
        };
    }

    // A wide window anchors the panel to the row; a phone pushes the page, which mounts this editor for that source.
    const openSource = (sourceKey: string) => {
        if (anchored && props.sheet?.onOpenSource) { props.sheet.onOpenSource(sourceKey); return; }
        if (anchored) { setOpenSourceId(sourceKey); return; }
        router.push(buildScopedSessionRouteHref({
            sessionId: props.destination.id,
            serverId,
            suffix: '/follow-source',
            query: { source: sourceKey },
        }) as Href);
    };

    if (props.page) {
        // A pair can carry a manager relation beside the ordinary follow; the panel edits the ordinary one.
        const matching = sources.filter((candidate) => followSourceKey(readFollowSourceRef(candidate)) === props.page?.sourceKey);
        const source = matching.find((candidate) => candidate.relation !== 'manager') ?? matching[0];
        const pageRule = source ? undefined : rules.find((rule) => ruleKey(rule) === props.page?.sourceKey);
        if (pageRule) return <>{props.page.frame(rulePanelParts(pageRule))}</>;
        // While the list loads, the frame already stands (its header, a loading line, Done) so nothing jumps in later.
        // Once read, a source that isn't listed any more says so, and a failed read offers Retry: the page never blanks.
        if (!source) return <>{props.page.frame({
            title: t('session.follow.sources.title'),
            subtitle: t('session.follow.sources.panelSubtitle'),
            mark: null,
            body: loading ? <Item title={t('common.loading')} loading showChevron={false} mode="info" />
                : failed ? <ItemGroup>{errorRow({})}</ItemGroup>
                    : <Item testID="session-follow-source-page-gone" title={t('session.follow.sources.sourceUnavailable')} showChevron={false} mode="info" />,
            footer: <SectionButtonRow trailing={<RoundButton testID="session-follow-source-page-done" title={t('common.done')} onPress={closePanel} />}>{null}</SectionButtonRow>,
        })}</>;
        return <>{props.page.frame(panelPartsFor(source))}</>;
    }

    const levelText = (preset: FollowPolicyV1['preset']) => (pane ? describeSessionFollowLevel(preset) : t(`session.follow.policy.${preset}`));
    // A Session source's line: its level once delivery is ready, else what its encrypted access is waiting for.
    const sessionSourceStatus = (source: SessionFollowSourceV1) => {
        const { session } = sessionTitle(source.sourceSessionId);
        const runtimeState = resolveSessionFollowSourceRuntimeState({
            accountScope,
            nowMs,
            deliveryState: source.deliveryState,
            machine: destinationMachine,
            sourceEncryptionMode: session?.encryptionMode ?? null,
            preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
            hasPendingUpdates: source.hasPendingUpdates,
        });
        const preparationSourceKey = sourcePreparationKey(preparationTargetKey, source.sourceSessionId);
        const currentFlightKey = `${preparationSourceKey}\u0000${edgeVersionBySourceIdRef.current.get(source.sourceSessionId) ?? 0}`;
        const preparing = preparingFlightKeys.has(currentFlightKey);
        const preparationWaitingReason = preparationWaitingReasons.get(preparationSourceKey);
        const presentedRuntimeState = refineSessionFollowSourceStateWithPreparationReason(runtimeState, preparationWaitingReason);
        // An unavailable SOURCE key can still become available (the Session is unlocked
        // in this client), so it keeps its retry; only an unavailable Runner key cannot.
        const canRetryPreparation = presentedRuntimeState === 'waiting_for_source_key'
            || presentedRuntimeState === 'waiting_for_runtime'
            || presentedRuntimeState === 'source_key_unavailable'
            || preparationWaitingReason === 'runner_unreachable';
        return {
            text: presentedRuntimeState === 'eligible' ? levelText(source.policy.preset) : sessionFollowSourceRuntimeStateLabel(presentedRuntimeState),
            preparing,
            retry: canRetryPreparation ? {
                disabled: !canPrepareSource || savingId !== null || preparing,
                onPress: () => { void prepareSource(source.sourceSessionId, 'retry'); },
            } : null,
        };
    };

    const sourceRows = <>
            {!online ? <Item
                {...rowLook}
                testID="session-follow-sources-offline"
                title={t('session.follow.offline')}
                accessibilityLiveRegion="polite"
                titleLines={0}
                showChevron={false}
                mode="info"
            /> : null}
            {loading && sources.length === 0 && rules.length === 0 ? <Item {...rowLook} title={t('common.loading')} loading showChevron={false} mode="info" /> : null}
            {!loading && sources.length === 0 && rules.length === 0 && !failed ? (paneSection
                ? <View style={styles.paneEmpty}><EmptyState testID="session-follow-sources-empty" layout="line" title={t('session.follow.sources.empty')} /></View>
                : <Item {...rowLook} testID="session-follow-sources-empty" title={t('session.follow.sources.empty')} showChevron={false} mode="info" />) : null}
            {sources.map((source) => {
                const { key, ref, session, sourceTitle, icon } = sourceIdentity(source);
                const status = isSessionSource(source) ? sessionSourceStatus(source) : {
                    // Another source kind has no key to prepare: it is current, paused while archived, or gone.
                    text: source.sourceAvailability === 'unavailable' ? t('session.follow.sources.sourceUnavailable')
                        : source.deliveryState === 'paused_archived' ? sessionFollowSourceRuntimeStateLabel('paused_archived')
                            : levelText(source.policy.preset),
                    preparing: false,
                    retry: null,
                };
                const open = panelOpen && openSourceId === key;
                return <SourceRowAnchor
                    key={key}
                    row={(triggerRef) => <Item
                        {...rowLook}
                        {...(pane ? { icon: ref.kind === 'session'
                            // A followed Session keeps its own Agent mark, like the session list (lab P1-P).
                            ? <FollowSessionMark session={session ?? null} serverId={serverId} rowGlyph />
                            : <Icon name={icon} size={18} color={theme.colors.text.secondary} /> } : {})}
                        pressableRef={triggerRef}
                        testID={`session-follow-source-${key}`}
                        accessibilityLabel={[
                            t('session.follow.sources.row', { title: sourceTitle }),
                            status.text,
                        ].join('. ')}
                        title={pane ? sourceTitle : t('session.follow.sources.row', { title: sourceTitle })}
                        titleLines={0}
                        subtitle={status.preparing ? t('session.follow.sources.sourceKeyPreparing') : status.text}
                        subtitleLines={0}
                        accessoryLayout="adaptive"
                        onPress={() => openSource(key)}
                        rightElementOutsidePressable
                        keepChevronWithRightElement
                        rightElement={status.retry ? <RoundButton
                            testID={`session-follow-source-${key}-retry`}
                            title={t('common.retry')}
                            size="small"
                            display="secondary"
                            accessibilityLabel={`${t('common.retry')}. ${t('session.follow.sources.row', { title: sourceTitle })}`}
                            disabled={status.retry.disabled}
                            onPress={status.retry.onPress}
                        /> : undefined}
                    />}
                    panel={open ? ({ anchorRef, triggerRef }) => {
                        const parts = panelPartsFor(source);
                        return <FollowEditorPanel anchorRef={anchorRef} focusReturnRef={triggerRef} onRequestClose={closePanel}
                            testID={`session-follow-source-${key}-panel`}
                            accessibilityLabel={parts.title}
                            title={parts.title} subtitle={parts.subtitle} mark={parts.mark} footer={parts.footer}>
                            {parts.body}
                        </FollowEditorPanel>;
                    } : null}
                />;
            })}
            {rules.map((rule) => {
                const key = ruleKey(rule);
                const title = ruleTitle(rule);
                const status = describeFollowRuleMatchCount(ruleCounts[key], levelText(rule.definition.policy.preset));
                const open = panelOpen && openSourceId === key;
                return <SourceRowAnchor
                    key={key}
                    row={(triggerRef) => <Item
                        {...rowLook}
                        {...(pane ? { icon: <Icon name="funnel-simple" size={18} color={theme.colors.text.secondary} /> } : {})}
                        pressableRef={triggerRef}
                        testID={`session-follow-source-${key}`}
                        accessibilityLabel={`${title}. ${status}`}
                        title={title}
                        titleLines={0}
                        subtitle={status}
                        subtitleLines={0}
                        onPress={() => openSource(key)}
                    />}
                    panel={open ? ({ anchorRef, triggerRef }) => {
                        const parts = rulePanelParts(rule);
                        return <FollowEditorPanel anchorRef={anchorRef} focusReturnRef={triggerRef} onRequestClose={closePanel}
                            testID={`session-follow-source-${key}-panel`}
                            accessibilityLabel={parts.title}
                            title={parts.title} subtitle={parts.subtitle} mark={parts.mark} footer={parts.footer}>
                            {parts.body}
                        </FollowEditorPanel>;
                    } : null}
                />;
            })}
            {failed || (mutation.error !== null && !panelOpen) ? errorRow(rowLook) : null}
    </>;

    const addRow = <Item
        pressableRef={addSourceRef}
        testID="session-follow-source-add"
        // In the sheet every row carries a mark, so Add keeps its title on the same edge (lab P1-P).
        {...(props.sheet ? { icon: <Icon name="plus" size={18} color={theme.colors.text.secondary} /> } : {})}
        title={t('session.follow.sources.addSource')}
        subtitle={t('session.follow.sources.includeNextTurn')}
        disabled={!online || savingId !== null}
        onPress={addSource}
    />;

    if (props.sheet) {
        return <ItemGroup>
            {sourceRows}
            {addRow}
        </ItemGroup>;
    }

    if (paneSection) {
        return <View testID="session-follow-sources-pane" style={styles.paneSection}>
            <PaneSectionHeader
                title={t('session.follow.sources.title')}
                count={!failed && sources.length + rules.length > 0 ? sources.length + rules.length : undefined}
                action={<IconButton
                    controlRef={(node) => { paneAddRef.current = node; }}
                    testID="session-follow-source-add"
                    iconName="plus"
                    size={28}
                    iconSize={15}
                    variant="plain"
                    accessibilityLabel={t('session.follow.sources.addSource')}
                    tooltip={t('session.follow.sources.addSource')}
                    disabled={!online || savingId !== null}
                    onPress={addSource}
                />}
            />
            {sourceRows}
        </View>;
    }

    return <>
        <ItemGroup title={t('session.follow.sources.title')}>
            {sourceRows}
        </ItemGroup>
        <ItemGroup title={t('common.add')}>
            {addRow}
        </ItemGroup>
    </>;
}

const styles = StyleSheet.create((theme) => ({
    paneSection: { paddingTop: theme.space.s12 },
    // The line starts where the section heading's text does.
    paneEmpty: { paddingLeft: theme.space.s8 },
    ruleScope: { marginBottom: theme.space.s12 },
}));
