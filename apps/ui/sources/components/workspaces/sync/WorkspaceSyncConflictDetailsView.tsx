import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import type {
    ReadWorkspaceSyncFileResultV1,
    WorkspaceSyncConflictInspectRpcResultV1,
    WorkspaceSyncConflictResolutionV1,
    WorkspaceSyncConflictResolutionResultV1,
    WorkspaceSyncEntryExpectationV1,
    WorkspaceSyncPathSelectionV1,
} from '@happier-dev/protocol';
import { areWorkspaceSyncEntryExpectationsEqual } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { inspectWorkspaceSyncConflict, resolveWorkspaceSyncConflict } from '@/sync/ops/workspaceSync';
import {
    getWorkspaceSyncConflictSnapshot,
    loadMoreWorkspaceSyncConflicts,
    refreshWorkspaceSyncConflicts,
    subscribeWorkspaceSyncConflicts,
} from '@/sync/domains/sessionHandoff/workspaceSyncConflictStore';
import { projectLoadedWorkspaceSyncConflicts, buildReviewedWorkspaceSyncResolution, isReviewedWorkspaceSyncResolutionCurrent, resolveWorkspaceSyncComparisonText } from '@/sync/domains/sessionHandoff/workspaceSyncConflictReviewModel';
import { useWorkspaceSyncRelationshipSummaries, resolveWorkspaceSyncStatusScope } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { refreshWorkspaceSyncStatuses } from '@/sync/domains/sessionHandoff/workspaceSyncStatusStore';
import { resolveWorkspaceSyncErrorTranslationKey, resolveWorkspaceSyncModeTranslationKey, resolveWorkspaceSyncRelationshipStateLabel } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { invokeDesktopHost, isDesktopHost } from '@/utils/platform/desktopHost';
import { VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from '@/utils/platform/viewportClass';

export function usesWorkspaceSyncSplitComparison(width: number): boolean {
    return width >= VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.expandedMin;
}

export type WorkspaceSyncConflictDetailsResource = Readonly<{
    kind: 'workspaceSyncConflicts';
    hubWorkspaceRefId: string;
    workspaceRefId: string;
    controllerMachineId: string;
    serverId?: string | null;
    initialPath?: string;
    initialRelationshipId?: string;
}>;

export function readWorkspaceSyncConflictDetailsResource(value: unknown): WorkspaceSyncConflictDetailsResource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = new Set(['kind', 'hubWorkspaceRefId', 'workspaceRefId', 'controllerMachineId', 'serverId', 'initialPath', 'initialRelationshipId']);
    if (Object.keys(value).some((key) => !allowed.has(key))) return null;
    const candidate = value as Partial<Record<keyof WorkspaceSyncConflictDetailsResource, unknown>>;
    if (candidate.kind !== 'workspaceSyncConflicts'
        || typeof candidate.hubWorkspaceRefId !== 'string' || !candidate.hubWorkspaceRefId.trim()
        || typeof candidate.workspaceRefId !== 'string' || !candidate.workspaceRefId.trim()
        || typeof candidate.controllerMachineId !== 'string' || !candidate.controllerMachineId.trim()
        || (candidate.serverId != null && typeof candidate.serverId !== 'string')
        || (candidate.initialPath !== undefined && typeof candidate.initialPath !== 'string')
        || (candidate.initialRelationshipId !== undefined && typeof candidate.initialRelationshipId !== 'string')) return null;
    return candidate as WorkspaceSyncConflictDetailsResource;
}

function entryLabel(entry: WorkspaceSyncEntryExpectationV1): string {
    switch (entry.kind) {
        case 'file': return `${t('workspaceSync.conflictKind.file')} · ${entry.executable ? t('workspaceSync.review.executable') : t('workspaceSync.review.regular')} · ${entry.size} B`;
        case 'symlink': return `${t('workspaceSync.conflictKind.symlink')} · ${entry.target}`;
        case 'directory': return t('workspaceSync.conflictKind.directory');
        case 'missing': return t('workspaceSync.conflictKind.missing');
    }
}

function previewLabel(preview: ReadWorkspaceSyncFileResultV1 | null): string {
    if (!preview) return t('workspaceSync.previewUnavailable');
    switch (preview.status) {
        case 'text': return t('workspaceSync.fileState.text');
        case 'binary': return t('workspaceSync.fileState.binary');
        case 'too_large': return t('workspaceSync.fileState.tooLarge');
        case 'missing': return t('workspaceSync.fileState.missing');
        case 'changed': return t('workspaceSync.fileState.changed');
    }
}

export function useSelectedPreview(input: Readonly<{
    controllerMachineId: string;
    serverId?: string | null;
    path: string | null;
    workspaceRefId: string | null;
    entry: WorkspaceSyncEntryExpectationV1 | null;
}>): Readonly<{ phase: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'; value: ReadWorkspaceSyncFileResultV1 | null }> {
    const [state, setState] = React.useState<Readonly<{
        key: string;
        identity: string;
        phase: 'loading' | 'refreshing' | 'ready' | 'error';
        value: ReadWorkspaceSyncFileResultV1 | null;
    }> | null>(null);
    const identity = input.path && input.workspaceRefId
        ? JSON.stringify([input.controllerMachineId, input.serverId, input.path, input.workspaceRefId]) : null;
    const key = input.path && input.workspaceRefId && input.entry?.kind === 'file'
        ? JSON.stringify([input.controllerMachineId, input.serverId, input.path, input.workspaceRefId, input.entry])
        : null;
    React.useEffect(() => {
        if (!key || !identity || !input.path || !input.workspaceRefId || !input.entry) return;
        const controller = new AbortController();
        let current = true;
        setState((previous) => ({ key, identity,
            phase: previous?.identity === identity && previous.value ? 'refreshing' : 'loading',
            value: previous?.identity === identity ? previous.value : null,
        }));
        void inspectWorkspaceSyncConflict({
            controllerMachineId: input.controllerMachineId,
            serverId: input.serverId,
            signal: controller.signal,
            request: {
                workspaceRefId: input.workspaceRefId,
                path: input.path,
                preview: { workspaceRefId: input.workspaceRefId, expected: input.entry },
            },
        }).then((result) => {
            if (!current) return;
            const preview = result.versions.find((version) => version.preview?.workspaceRefId === input.workspaceRefId)?.preview?.preview ?? null;
            setState((previous) => ({ key, identity, phase: preview ? 'ready' : 'error',
                value: preview ?? (previous?.identity === identity ? previous.value : null) }));
        }, () => {
            if (current) setState((previous) => ({ key, identity, phase: 'error',
                value: previous?.identity === identity ? previous.value : null }));
        });
        return () => { current = false; controller.abort(); };
    }, [input.controllerMachineId, input.path, input.serverId, input.workspaceRefId, identity, key]);
    if (!key) return { phase: 'idle', value: null };
    if (state?.key === key) return state;
    return state?.identity === identity && state.value
        ? { phase: 'refreshing', value: state.value }
        : { phase: 'loading', value: null };
}

function resultLabel(status: WorkspaceSyncConflictResolutionResultV1['endpoints'][number]['status']): string {
    switch (status) {
        case 'applied': return t('workspaceSync.review.applied');
        case 'applied_paused': return t('workspaceSync.review.appliedPaused');
        case 'changed': return t('workspaceSync.review.changed');
        case 'offline': return t('workspaceSync.review.offline');
        case 'cancelled': return t('workspaceSync.review.cancelled');
        case 'unknown': return t('workspaceSync.review.unknown');
        case 'failed': return t('workspaceSync.review.failed');
        case 'recovery_needed': return t('workspaceSync.review.recoveryNeeded');
    }
}

function preservationResultLabel(status: NonNullable<WorkspaceSyncConflictResolutionResultV1['preserved']>[number]['outcome']['status']): string {
    if (status === 'preserved') return t('workspaceSync.review.preserved');
    if (status === 'already_present') return t('workspaceSync.review.alreadyPresent');
    if (status === 'not_started') return t('workspaceSync.review.notStarted');
    return resultLabel(status);
}

function selectionLabel(decision: WorkspaceSyncPathSelectionV1): string {
    if (decision.status === 'included') return t('workspaceSync.review.selectionIncluded');
    const reasonKey = {
        repository_metadata: 'workspaceSync.review.reasonRepositoryMetadata',
        submodule: 'workspaceSync.review.reasonSubmodule',
        configured_rule: 'workspaceSync.review.reasonConfiguredRule',
        git_ignore: 'workspaceSync.review.reasonGitIgnore',
        endpoint_unavailable: 'workspaceSync.review.reasonEndpointUnavailable',
        selection_unavailable: 'workspaceSync.review.reasonSelectionUnavailable',
    } as const;
    return `${t(decision.status === 'excluded' ? 'workspaceSync.review.selectionExcluded' : 'workspaceSync.review.selectionUnknown')} · ${t(reasonKey[decision.reason])}`;
}

function WorkspaceSyncRecoveryLocation(props: Readonly<{
    path: string;
    machineId: string | null;
    machineLabel: string;
}>) {
    const localMachineId = useLocalDaemonControl().status?.machineId ?? null;
    const canReveal = isDesktopHost() && localMachineId !== null && localMachineId === props.machineId;
    return <View style={{ gap: 8 }}>
        <Item title={t('workspaceSync.review.recoveryNeeded')}
            subtitle={`${props.machineLabel} · ${props.path}`} copy={props.path} subtitleLines={0} showChevron={false} />
        {canReveal ? <RoundButton size="normal" display="inverted" title={t('workspaceSync.legacyRecovery.openFolder')}
            onPress={() => { void invokeDesktopHost('system_tasks_open_log_path', { path: props.path }); }} /> : null}
    </View>;
}

export const WorkspaceSyncConflictDetailsView = React.memo(function WorkspaceSyncConflictDetailsView(props: Readonly<{
    resource: WorkspaceSyncConflictDetailsResource;
    approvedRequest?: WorkspaceSyncConflictResolutionV1;
    reportedOutcome?: WorkspaceSyncConflictResolutionResultV1;
    embedded?: boolean;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const summaries = useWorkspaceSyncRelationshipSummaries(props.resource.hubWorkspaceRefId, props.resource.serverId ?? undefined);
    const relationshipKey = summaries.map((summary) => [
        summary.relationshipId,
        summary.relationship.controllerMachineId,
        summary.alpha.workspaceRef?.serverId ?? summary.beta.workspaceRef?.serverId ?? '',
    ].join(':')).join('\u0000');
    const scopes = React.useMemo(() => summaries.map(resolveWorkspaceSyncStatusScope), [relationshipKey]);
    const currentControllerMachineId = scopes[0]?.controllerMachineId ?? props.resource.controllerMachineId;
    const currentServerId = scopes[0]?.serverId ?? props.resource.serverId;
    const [conflictsRevision, rerender] = React.useReducer((value: number) => value + 1, 0);
    const [paneWidth, setPaneWidth] = React.useState(0);
    const splitComparison = usesWorkspaceSyncSplitComparison(paneWidth) && !props.embedded;
    const [selectedPath, setSelectedPath] = React.useState<string | null>(props.approvedRequest?.path ?? props.resource.initialPath ?? null);
    const inspectionScopeKey = JSON.stringify([
        currentControllerMachineId, currentServerId, props.resource.hubWorkspaceRefId, props.resource.workspaceRefId,
        summaries.map((summary) => [
            summary.relationshipId, summary.relationship.updatedAtMs, summary.relationship.mode,
            summary.relationship.contentPolicy.policyDigest, summary.relationship.enabled,
            summary.alpha.workspaceRef?.machineId, summary.alpha.workspaceRef?.serverId, summary.alpha.workspaceRef?.rootPath,
            summary.beta.workspaceRef?.machineId, summary.beta.workspaceRef?.serverId, summary.beta.workspaceRef?.rootPath,
        ]),
    ]);
    const [inspection, setInspection] = React.useState<Readonly<{ scopeKey: string; value: WorkspaceSyncConflictInspectRpcResultV1 }> | null>(null);
    const [inspectionPhase, setInspectionPhase] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [inspectionRevision, refreshInspection] = React.useReducer((value: number) => value + 1, 0);
    const [sourceWorkspaceRefId, setSourceWorkspaceRefId] = React.useState<string | null>(props.approvedRequest?.source.workspaceRefId ?? null);
    const [selectedTargetWorkspaceRefIds, setSelectedTargetWorkspaceRefIds] = React.useState<readonly string[] | null>(
        props.approvedRequest?.targets.map((target) => target.workspaceRefId) ?? null,
    );
    const [compareWorkspaceRefId, setCompareWorkspaceRefId] = React.useState<string | null>(null);
    const [outcome, setOutcome] = React.useState<WorkspaceSyncConflictResolutionResultV1 | null>(null);
    const visibleOutcome = props.reportedOutcome ?? outcome;
    const [resolveError, setResolveError] = React.useState<'changed' | 'failed' | null>(null);
    const [resolving, setResolving] = React.useState(false);
    const [actionPhase, setActionPhase] = React.useState<'requesting_approval' | 'applying' | null>(null);
    const [reinspectingTerminal, setReinspectingTerminal] = React.useState(false);
    const reinspectAfterTerminalRef = React.useRef(false);
    const activeScopeKeyRef = React.useRef(inspectionScopeKey);
    const previousScopeKeyRef = React.useRef(inspectionScopeKey);
    activeScopeKeyRef.current = inspectionScopeKey;
    const [diagnosticsExpanded, setDiagnosticsExpanded] = React.useState(false);
    const actionRef = React.useRef<FocusReturnTarget>(null);
    const rowFocusRef = React.useRef<FocusReturnTarget>(null);
    const returnToRowRef = React.useRef(false);
    const returnedPathRef = React.useRef<string | null>(null);
    const listRef = React.useRef<VirtualizedListRef | null>(null);
    const listScrollOffsetRef = React.useRef(0);

    React.useEffect(() => {
        if (previousScopeKeyRef.current === inspectionScopeKey) return;
        previousScopeKeyRef.current = inspectionScopeKey;
        reinspectAfterTerminalRef.current = false;
        setReinspectingTerminal(false);
        setOutcome(null);
        setResolveError(null);
        setResolving(false);
        setActionPhase(null);
        setSourceWorkspaceRefId(props.approvedRequest?.source.workspaceRefId ?? null);
        setSelectedTargetWorkspaceRefIds(props.approvedRequest?.targets.map((target) => target.workspaceRefId) ?? null);
        setCompareWorkspaceRefId(null);
    }, [inspectionScopeKey, props.approvedRequest]);

    React.useEffect(() => {
        const unsubscribers = scopes.map((scope) => {
            const unsubscribe = subscribeWorkspaceSyncConflicts(scope, rerender);
            void refreshWorkspaceSyncConflicts(scope).catch(() => undefined);
            return unsubscribe;
        });
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    }, [scopes]);

    const { snapshots, projection } = React.useMemo(() => {
        const snapshots = scopes.map((scope) => ({ scope, snapshot: getWorkspaceSyncConflictSnapshot(scope) }));
        const projection = projectLoadedWorkspaceSyncConflicts({
            relationships: scopes.map((scope) => ({ relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId })),
            pages: snapshots.flatMap(({ scope, snapshot }) => snapshot.list ? [{
                relationshipId: scope.relationshipId,
                page: {
                    status: 'page' as const,
                    relationshipId: scope.relationshipId,
                    totalCount: snapshot.list.totalCount,
                    nextCursor: snapshot.nextCursor,
                    conflicts: snapshot.list.conflicts,
                },
            }] : []),
        });
        return { snapshots, projection };
    }, [scopes, conflictsRevision]);
    const invalidated = snapshots.some(({ snapshot }) => snapshot.invalidated || snapshot.phase === 'error');
    const selectedRow = projection.rows.find((row) => row.path === selectedPath);

    React.useEffect(() => {
        if (selectedPath || !returnToRowRef.current) return;
        returnToRowRef.current = false;
        let cancelled = false;
        let frame: number | null = null;
        void Promise.resolve(listRef.current?.scrollToOffset({ offset: listScrollOffsetRef.current, animated: false })).then(() => {
            if (cancelled) return;
            frame = requestAnimationFrame(() => {
                restoreFocusToBestTarget(rowFocusRef);
                returnedPathRef.current = null;
            });
        });
        return () => {
            cancelled = true;
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [selectedPath]);

    React.useEffect(() => {
        if (!selectedPath) return;
        const controller = new AbortController();
        let current = true;
        setInspectionPhase('loading');
        void inspectWorkspaceSyncConflict({
            controllerMachineId: currentControllerMachineId,
            serverId: currentServerId,
            signal: controller.signal,
            request: { workspaceRefId: props.resource.workspaceRefId, path: selectedPath },
        }).then((result) => {
            if (!current) return;
            setInspection({ scopeKey: inspectionScopeKey, value: result });
            setInspectionPhase('ready');
            if (reinspectAfterTerminalRef.current) {
                reinspectAfterTerminalRef.current = false;
                setReinspectingTerminal(false);
                setOutcome(null);
                setResolveError(null);
            }
        }, () => {
            if (current) {
                setInspectionPhase('error');
                if (reinspectAfterTerminalRef.current) {
                    reinspectAfterTerminalRef.current = false;
                    setReinspectingTerminal(false);
                }
            }
        });
        return () => { current = false; controller.abort(); };
    }, [currentControllerMachineId, currentServerId, props.resource.workspaceRefId, selectedPath, inspectionRevision, inspectionScopeKey]);

    const currentInspection = inspection?.scopeKey === inspectionScopeKey && inspection.value.path === selectedPath
        ? inspection.value : null;
    const versionIds = currentInspection?.versions.flatMap((version) => version.endpointWorkspaceRefIds) ?? [];
    const sourceId = props.approvedRequest?.source.workspaceRefId ?? sourceWorkspaceRefId ?? versionIds[0] ?? null;
    const defaultCompareId = currentInspection?.versions.find((version) => !version.endpointWorkspaceRefIds.includes(sourceId ?? ''))
        ?.endpointWorkspaceRefIds[0] ?? null;
    const compareId = compareWorkspaceRefId && compareWorkspaceRefId !== sourceId
        ? compareWorkspaceRefId
        : defaultCompareId;
    const sourceVersion = currentInspection?.versions.find((version) => version.endpointWorkspaceRefIds.includes(sourceId ?? '')) ?? null;
    const compareVersion = currentInspection?.versions.find((version) => version.endpointWorkspaceRefIds.includes(compareId ?? '')) ?? null;
    const eligibleTargetIds = currentInspection?.endpoints.filter((endpoint) => endpoint.outcome === 'observed'
        && endpoint.observation && endpoint.workspaceRefId !== sourceId && sourceVersion
        && !areWorkspaceSyncEntryExpectationsEqual(endpoint.observation, sourceVersion.entry))
        .map((endpoint) => endpoint.workspaceRefId) ?? [];
    const targetIds = selectedTargetWorkspaceRefIds
        ?? (currentInspection?.endpoints.length === 2 && eligibleTargetIds.length === 1 ? eligibleTargetIds : []);
    const sourcePreview = useSelectedPreview({
        controllerMachineId: currentControllerMachineId, serverId: currentServerId,
        path: selectedPath, workspaceRefId: sourceId, entry: sourceVersion?.entry ?? null,
    });
    const comparePreview = useSelectedPreview({
        controllerMachineId: currentControllerMachineId, serverId: currentServerId,
        path: selectedPath, workspaceRefId: compareId, entry: compareVersion?.entry ?? null,
    });

    const endpointFor = (workspaceRefId: string) => summaries.flatMap((summary) => [summary.alpha, summary.beta])
        .find((endpoint) => endpoint.workspaceRefId === workspaceRefId);
    const selectedAgentServerId = sourceId ? endpointFor(sourceId)?.workspaceRef?.serverId : null;
    const accountBindings = useServerCredentialAccountScopeBindings([selectedAgentServerId]);
    const accountBinding = accountBindings.values().next().value;
    const endpointLabel = (workspaceRefId: string) => {
        const endpoint = endpointFor(workspaceRefId);
        return endpoint ? `${endpoint.machineName ?? endpoint.workspaceRef?.machineId ?? workspaceRefId} · ${endpoint.label}` : workspaceRefId;
    };
    const endpointRoot = (workspaceRefId: string) => endpointFor(workspaceRefId)?.workspaceRef?.rootPath ?? null;
    const consequenceLines = (consequence: Readonly<{
        propagatingToWorkspaceRefIds: readonly string[];
        unverifiedPropagationToWorkspaceRefIds?: readonly string[];
    }>) => consequence.propagatingToWorkspaceRefIds.length === 0
        && !consequence.unverifiedPropagationToWorkspaceRefIds?.length
        ? [t('workspaceSync.review.localOnly')]
        : [
        ...(consequence.propagatingToWorkspaceRefIds.length ? [t('workspaceSync.review.propagationExpected', {
            names: consequence.propagatingToWorkspaceRefIds.map(endpointLabel).join(', '),
        })] : []),
        ...(consequence.unverifiedPropagationToWorkspaceRefIds?.length ? [t('workspaceSync.review.propagationUnverified', {
            names: consequence.unverifiedPropagationToWorkspaceRefIds.map(endpointLabel).join(', '),
        })] : []),
        ];
    const relationshipLabel = (relationshipId: string) => {
        const summary = summaries.find((candidate) => candidate.relationshipId === relationshipId);
        return summary
            ? `${endpointLabel(summary.alpha.workspaceRefId)} ${summary.relationship.mode === 'keep_both_in_sync' ? '↔' : '→'} ${endpointLabel(summary.beta.workspaceRefId)}`
            : relationshipId;
    };
    const askAgent = () => {
        if (!currentInspection || !selectedPath || !sourceId || !accountBinding?.isCurrent()) return;
        const selected = endpointFor(sourceId)?.workspaceRef;
        if (!selected?.machineId || !selected.rootPath || !selected.serverId) return;
        const versions = currentInspection.versions.map((version) =>
            `${version.endpointWorkspaceRefIds.map(endpointLabel).join(' · ')} — ${entryLabel(version.entry)}`).join('\n');
        seedAndOpenNewSession({
            seed: {
                prompt: t('workspaceSync.review.askAgentPrompt', { path: selectedPath, versions }),
                placement: { kind: 'exactTarget', serverId: selected.serverId, machineId: selected.machineId, directory: selected.rootPath },
            },
            scope: accountBinding.scope,
            isCurrent: () => accountBinding.isCurrent(),
            navigateToNewSession: ({ draftId, machineId, directory, spawnServerId, worktree }) => {
                router.push({ pathname: '/new', params: {
                    ...buildNewSessionLaunchRouteParams({ draftId, machineId, directory, targetServerId: spawnServerId, worktree }),
                } });
            },
        });
    };
    const comparisonText = sourceVersion && compareVersion
        ? resolveWorkspaceSyncComparisonText({
            left: sourceVersion.entry, right: compareVersion.entry,
            leftPreview: sourcePreview.value, rightPreview: comparePreview.value,
        }) : null;
    const relationshipIds = scopes.map((scope) => scope.relationshipId);
    const approvedCurrent = !props.approvedRequest || Boolean(currentInspection
        && relationshipIds.length === props.approvedRequest.relationshipIds.length
        && relationshipIds.every((id) => props.approvedRequest?.relationshipIds.includes(id))
        && isReviewedWorkspaceSyncResolutionCurrent(currentInspection, props.approvedRequest));
    const refresh = () => {
        void Promise.all(scopes.map((scope) => refreshWorkspaceSyncConflicts(scope).catch(() => undefined)));
        void refreshWorkspaceSyncStatuses(scopes).catch(() => undefined);
        if (selectedPath) refreshInspection();
    };
    const resolve = async (workspaceRefId: string, strategy: WorkspaceSyncConflictResolutionV1['strategy']) => {
        if (!currentInspection || resolving || inspectionPhase !== 'ready' || scopes.length === 0) return;
        const requestedScopeKey = inspectionScopeKey;
        const request = buildReviewedWorkspaceSyncResolution({
            inspection: currentInspection, sourceWorkspaceRefId: workspaceRefId,
            selectedTargetWorkspaceRefIds: targetIds, relationshipIds, strategy,
        });
        if (!request) return;
        const untouched = currentInspection.endpoints.filter((endpoint) => endpoint.workspaceRefId !== request.source.workspaceRefId
            && !request.targets.some((target) => target.workspaceRefId === endpoint.workspaceRefId));
        const reviewedTargets = request.targets.map((target) => `${endpointLabel(target.workspaceRefId)} · ${entryLabel(target.expected)}`);
        const preserved = request.strategy === 'keep_both' ? request.alternatives.flatMap((alternative) => [
            `${endpointLabel(alternative.source.workspaceRefId)} · ${entryLabel(alternative.source.expected)} → ${endpointLabel(alternative.destination.workspaceRefId)} · ${alternative.destination.path}`,
            ...consequenceLines(alternative.consequence),
        ]) : [];
        const confirmed = await Modal.confirm(
            t('workspaceSync.review.confirmTitle'),
            [request.path, `${endpointLabel(workspaceRefId)} · ${entryLabel(request.source.expected)}`, ...reviewedTargets, ...preserved,
                ...untouched.map((endpoint) => `${endpointLabel(endpoint.workspaceRefId)} · ${t(endpoint.outcome === 'observed'
                    ? 'workspaceSync.review.notSelected' : 'workspaceSync.review.notReviewed')}`),
                ...(untouched.some((endpoint) => endpoint.outcome !== 'observed') ? [t('workspaceSync.review.confirmScope')] : [])].join('\n'),
            { cancelText: t('common.cancel'), confirmText: t(strategy === 'keep_both' ? 'workspaceSync.review.keepAlternatives' : 'workspaceSync.review.useVersion'), destructive: true, focusReturnRef: actionRef },
        );
        if (!confirmed || activeScopeKeyRef.current !== requestedScopeKey) return;
        setResolving(true);
        setActionPhase('requesting_approval');
        setResolveError(null);
        try {
            const result = await resolveWorkspaceSyncConflict({
                controllerMachineId: currentControllerMachineId,
                serverId: currentServerId,
                request,
                onPhase: setActionPhase,
            });
            if (activeScopeKeyRef.current !== requestedScopeKey) return;
            setOutcome(result);
            refresh();
        } catch (error: unknown) {
            if (activeScopeKeyRef.current !== requestedScopeKey) return;
            const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
            setResolveError(code === 'conflict_changed' ? 'changed' : 'failed');
            if (code === 'conflict_changed') refresh();
        } finally {
            if (activeScopeKeyRef.current === requestedScopeKey) {
                setResolving(false);
                setActionPhase(null);
            }
        }
    };

    const canResolve = scopes.length > 0 && inspectionPhase === 'ready' && !outcome && !resolveError;
    const selectedResolution = currentInspection && sourceId
        ? buildReviewedWorkspaceSyncResolution({ inspection: currentInspection, sourceWorkspaceRefId: sourceId,
            selectedTargetWorkspaceRefIds: targetIds, relationshipIds }) : null;
    const selectedKeepAlternatives = currentInspection && sourceId
        ? buildReviewedWorkspaceSyncResolution({ inspection: currentInspection, sourceWorkspaceRefId: sourceId,
            selectedTargetWorkspaceRefIds: targetIds, relationshipIds, strategy: 'keep_both' }) : null;
    const selectedDetail = selectedPath ? (
            <View style={props.embedded ? undefined : { flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}>
                    {!props.approvedRequest ? <IconButton iconName="arrow-left" accessibilityLabel={t('common.back')} onPress={() => {
                        returnToRowRef.current = true;
                        returnedPathRef.current = selectedPath;
                        rowFocusRef.current = null;
                        setSelectedPath(null);
                    }} /> : null}
                    <Text numberOfLines={2} style={{ flex: 1 }}>{selectedPath}</Text>
                    <IconButton iconName="arrow-clockwise" accessibilityLabel={t('workspaceSync.actions.refresh')} onPress={refresh} />
                </View>
                <ScrollView scrollEnabled={!props.embedded} style={props.embedded ? undefined : { flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
                    {inspectionPhase === 'loading' ? <Text style={{ padding: 16 }}>{t('common.loading')}</Text> : null}
                    {inspectionPhase === 'error' ? <Text accessibilityLiveRegion="polite" style={{ padding: 16 }}>{t('workspaceSync.review.inspectionUnavailable')}</Text> : null}
                    {props.approvedRequest && inspectionPhase === 'ready' && !approvedCurrent ? <Text accessibilityLiveRegion="polite"
                        style={{ padding: 16, color: theme.colors.state.warning.foreground }}>
                        {t('workspaceSync.resolve.changedBody')}
                    </Text> : null}
                    {!selectedRow || invalidated || !projection.coverage.complete || !currentInspection?.coverage.complete ? (
                        <Text accessibilityLiveRegion="polite" style={{ padding: 16, color: theme.colors.state.warning.foreground }}>
                            {t('workspaceSync.review.coverageIncomplete')}
                        </Text>
                    ) : null}
                    {props.approvedRequest ? <ItemGroup title={t('approvals.details')}>
                        <Item title={t('workspaceSync.review.useVersion')}
                            subtitle={`${endpointLabel(props.approvedRequest.source.workspaceRefId)} · ${entryLabel(props.approvedRequest.source.expected)}`}
                            mode="info" />
                        {props.approvedRequest.targets.map((target) => <Item key={target.workspaceRefId}
                            title={endpointLabel(target.workspaceRefId)} subtitle={entryLabel(target.expected)} mode="info" />)}
                        {currentInspection?.endpoints.filter((endpoint) => endpoint.workspaceRefId !== props.approvedRequest?.source.workspaceRefId
                            && !props.approvedRequest?.targets.some((target) => target.workspaceRefId === endpoint.workspaceRefId))
                            .map((endpoint) => <Item key={`untouched:${endpoint.workspaceRefId}`}
                                title={endpointLabel(endpoint.workspaceRefId)}
                                subtitle={t(endpoint.outcome === 'observed' ? 'workspaceSync.review.notSelected' : 'workspaceSync.review.notReviewed')}
                                mode="info" />)}
                        {props.approvedRequest.strategy === 'keep_both' ? props.approvedRequest.alternatives.map((alternative) => <Item
                            key={`${alternative.source.workspaceRefId}:${alternative.destination.path}`}
                            title={t('workspaceSync.review.preserveAt', { path: alternative.destination.path })}
                            subtitle={[`${endpointLabel(alternative.source.workspaceRefId)} → ${endpointLabel(alternative.destination.workspaceRefId)}`,
                                endpointRoot(alternative.destination.workspaceRefId), ...consequenceLines(alternative.consequence)].filter(Boolean).join(' · ')}
                            copy={alternative.destination.path} mode="info" />) : null}
                    </ItemGroup> : null}
                    {currentInspection ? (
                        <>
                            <ItemGroup title={t('workspaceSync.review.versions')}
                                accessibilityRole={props.approvedRequest ? undefined : 'radiogroup'}
                                accessibilityLabel={props.approvedRequest ? undefined : t('workspaceSync.review.versions')}>
                                {currentInspection.versions.map((version) => {
                                    const id = sourceId && version.endpointWorkspaceRefIds.includes(sourceId)
                                        ? sourceId : version.endpointWorkspaceRefIds[0]!;
                                    return <React.Fragment key={id}>
                                        <Item
                                            title={version.endpointWorkspaceRefIds.map(endpointLabel).join(' · ')}
                                            subtitle={[entryLabel(version.entry), ...version.endpointWorkspaceRefIds.map(endpointRoot).filter((root): root is string => Boolean(root))].join(' · ')}
                                            subtitleLines={0}
                                            selected={props.approvedRequest ? undefined : id === sourceId}
                                            accessibilityRole={props.approvedRequest ? undefined : 'radio'}
                                            accessibilityChecked={props.approvedRequest ? undefined : id === sourceId}
                                            mode={props.approvedRequest ? 'info' : undefined}
                                            onPress={props.approvedRequest ? undefined : () => {
                                                setSourceWorkspaceRefId(id);
                                                setSelectedTargetWorkspaceRefIds((previous) => previous?.filter((targetId) => targetId !== id) ?? null);
                                            }}
                                        />
                                        {currentInspection.versions.length > 2 && !version.endpointWorkspaceRefIds.includes(sourceId ?? '') ? (
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
                                                <RoundButton size="normal" display="inverted"
                                                    title={t('workspaceSync.review.compareNamedVersion', { name: endpointLabel(id) })}
                                                    onPress={() => setCompareWorkspaceRefId(id)} />
                                            </View>
                                        ) : null}
                                    </React.Fragment>;
                                })}
                            </ItemGroup>
                            {!props.approvedRequest && currentInspection.endpoints.length > 2 ? <ItemGroup title={t('workspaceSync.review.chooseTargets')}>
                                {currentInspection.endpoints.filter((endpoint) => endpoint.workspaceRefId !== sourceId).map((endpoint) => {
                                    const eligible = eligibleTargetIds.includes(endpoint.workspaceRefId);
                                    const selected = targetIds.includes(endpoint.workspaceRefId);
                                    const editable = eligible || selected;
                                    return <Item key={`target:${endpoint.workspaceRefId}`}
                                        title={endpointLabel(endpoint.workspaceRefId)}
                                        subtitle={endpoint.observation ? entryLabel(endpoint.observation) : t('workspaceSync.review.notReviewed')}
                                        selected={editable ? selected : undefined}
                                        accessibilityRole={editable ? 'checkbox' : undefined}
                                        accessibilityChecked={editable ? selected : undefined}
                                        mode={editable ? 'interactive' : 'info'}
                                        onPress={editable ? () => setSelectedTargetWorkspaceRefIds((previous) => {
                                            const current = previous ?? targetIds;
                                            return current.includes(endpoint.workspaceRefId)
                                                ? current.filter((id) => id !== endpoint.workspaceRefId)
                                                : [...current, endpoint.workspaceRefId];
                                        }) : undefined} />;
                                })}
                            </ItemGroup> : null}
                            {!props.approvedRequest && currentInspection.endpoints.filter((endpoint) => endpoint.outcome !== 'observed').length > 0 ? <ItemGroup title={t('workspaceSync.review.notReviewed')}>
                                {currentInspection.endpoints.filter((endpoint) => endpoint.outcome !== 'observed').map((endpoint) => <Item
                                    key={`unobserved:${endpoint.workspaceRefId}`}
                                    title={endpointLabel(endpoint.workspaceRefId)}
                                    subtitle={t('workspaceSync.review.notReviewed')}
                                    mode="info" />)}
                            </ItemGroup> : null}
                            <ItemGroup title={t('workspaceSync.review.comparison')}>
                                <Item title={sourceId ? endpointLabel(sourceId) : t('workspaceSync.review.unknown')}
                                    subtitle={sourceVersion ? entryLabel(sourceVersion.entry) : t('workspaceSync.review.unknown')} mode="info" />
                                <Item title={compareId ? endpointLabel(compareId) : t('workspaceSync.review.unknown')}
                                    subtitle={compareVersion ? entryLabel(compareVersion.entry) : t('workspaceSync.review.unknown')} mode="info" />
                                {sourcePreview.phase === 'refreshing' || comparePreview.phase === 'refreshing'
                                    || (sourcePreview.phase === 'error' && sourcePreview.value)
                                    || (comparePreview.phase === 'error' && comparePreview.value)
                                    ? <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, color: theme.colors.state.warning.foreground }}>
                                        {t('workspaceSync.previewUnavailable')}
                                    </Text> : null}
                                {comparisonText ? (
                                        <DiffViewer mode="text" filePath={selectedPath} oldText={comparisonText.oldText} newText={comparisonText.newText}
                                            showLineNumbers={true} presentationStyleOverride="unified" />
                                    ) : (
                                        <View style={{ padding: 16, gap: 8 }}>
                                            <Text>{sourceVersion?.entry.kind === 'file' ? (sourcePreview.phase === 'loading' ? t('common.loading') : previewLabel(sourcePreview.value)) : sourceVersion ? entryLabel(sourceVersion.entry) : t('workspaceSync.review.unknown')}</Text>
                                            <Text>{compareVersion?.entry.kind === 'file' ? (comparePreview.phase === 'loading' ? t('common.loading') : previewLabel(comparePreview.value)) : compareVersion ? entryLabel(compareVersion.entry) : t('workspaceSync.review.unknown')}</Text>
                                        </View>
                                    )}
                            </ItemGroup>
                            {actionPhase ? <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                {t(actionPhase === 'applying' ? 'workspaceSync.review.applying' : 'workspaceSync.review.requestingApproval')}
                            </Text> : null}
                            <ItemGroup title={t('workspaceSync.review.linkDecisions')}>
                                {summaries.map((summary) => <Item key={`policy:${summary.relationshipId}`}
                                    title={relationshipLabel(summary.relationshipId)}
                                    subtitle={[
                                        t(summary.relationship.contentPolicy.selection === 'git_worktree'
                                            ? 'settingsSession.handoff.contentSelection.gitTitle'
                                            : 'settingsSession.handoff.contentSelection.allFilesTitle'),
                                        ...summary.relationship.contentPolicy.extraIncludePatterns.map((pattern) => t('workspaceSync.review.configuredInclude', { pattern })),
                                        ...summary.relationship.contentPolicy.extraIgnorePatterns.map((pattern) => t('workspaceSync.review.configuredExclude', { pattern })),
                                    ].join(' · ')} subtitleLines={0} mode="info" />)}
                                {currentInspection.endpoints.flatMap((endpoint) => endpoint.selections.map((selection) => (
                                    <Item key={`${endpoint.workspaceRefId}:${selection.relationshipId}:${selection.side}`}
                                        title={endpointLabel(endpoint.workspaceRefId)}
                                        subtitle={`${relationshipLabel(selection.relationshipId)} · ${selectionLabel(selection.decision)}`}
                                        subtitleLines={0}
                                        mode="info" />
                                )))}
                            </ItemGroup>
                        </>
                    ) : null}
                    {visibleOutcome ? <View accessibilityLiveRegion="polite"><ItemGroup title={t('workspaceSync.review.result')}>
                                {visibleOutcome.endpoints.map((endpoint) => <Item key={endpoint.workspaceRefId}
                                    title={endpointLabel(endpoint.workspaceRefId)}
                                    subtitle={[resultLabel(endpoint.status), 'errorCode' in endpoint ? endpoint.errorCode : null].filter(Boolean).join(' · ')} mode="info" />)}
                                {visibleOutcome.endpoints.flatMap((endpoint) => endpoint.status === 'recovery_needed' ? [
                                    <WorkspaceSyncRecoveryLocation key={`recovery:${endpoint.workspaceRefId}`}
                                        path={endpoint.recoveryPath}
                                        machineId={endpointFor(endpoint.workspaceRefId)?.workspaceRef?.machineId ?? null}
                                        machineLabel={endpointLabel(endpoint.workspaceRefId)} />,
                                ] : [])}
                                {visibleOutcome.preserved?.map((preserved) => <Item key={`preserved:${preserved.alternativeIndex}`}
                                    title={t('workspaceSync.review.preserveAt', { path: preserved.path })}
                                    subtitle={[`${endpointLabel(preserved.sourceWorkspaceRefId)} → ${endpointLabel(preserved.destinationWorkspaceRefId)}`,
                                        endpointRoot(preserved.destinationWorkspaceRefId),
                                        preservationResultLabel(preserved.outcome.status),
                                        'errorCode' in preserved.outcome ? preserved.outcome.errorCode : null,
                                        ...consequenceLines(preserved)].filter(Boolean).join(' · ')}
                                    copy={preserved.path} subtitleLines={0} mode="info" />)}
                                {visibleOutcome.preserved?.flatMap((preserved) => preserved.outcome.status === 'recovery_needed' ? [
                                    <WorkspaceSyncRecoveryLocation key={`preserved-recovery:${preserved.alternativeIndex}`}
                                        path={preserved.outcome.recoveryPath}
                                        machineId={endpointFor(preserved.destinationWorkspaceRefId)?.workspaceRef?.machineId ?? null}
                                        machineLabel={endpointLabel(preserved.destinationWorkspaceRefId)} />,
                                ] : [])}
                            </ItemGroup></View> : null}
                    {props.approvedRequest && visibleOutcome ? <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                        <RoundButton size="normal" display="inverted"
                            title={t('workspaceSync.review.inspectCurrentVersions')}
                            loading={inspectionPhase === 'loading'} disabled={inspectionPhase === 'loading'}
                            onPress={refresh} />
                    </View> : null}
                    {resolveError ? <Text accessibilityLiveRegion="polite" style={{ padding: 16 }}>
                                {resolveError === 'changed' ? t('workspaceSync.resolve.changedBody') : t('errors.operationFailed')}
                            </Text> : null}
                </ScrollView>
                {!props.approvedRequest && currentInspection && sourceId ? <View style={{ padding: 12, gap: 8 }}>
                    <Text numberOfLines={2}>{endpointLabel(sourceId)} · {sourceVersion ? entryLabel(sourceVersion.entry) : t('workspaceSync.review.unknown')}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {outcome || resolveError ? <RoundButton size="normal"
                            title={t('workspaceSync.review.inspectCurrentVersions')}
                            disabled={reinspectingTerminal} loading={reinspectingTerminal}
                            onPress={() => {
                                if (reinspectingTerminal) return;
                                reinspectAfterTerminalRef.current = true;
                                setReinspectingTerminal(true);
                                refresh();
                            }} /> : <RoundButton size="normal"
                            title={t('workspaceSync.review.useNamedVersion', { name: endpointLabel(sourceId) })}
                            titleNumberOfLines="complete"
                            accessibilityLabel={t('workspaceSync.review.useNamedVersion', { name: endpointLabel(sourceId) })}
                            style={{ flexBasis: '100%', minWidth: 0 }}
                            textStyle={{ maxWidth: '100%' }}
                            disabled={!canResolve || resolving || !selectedResolution}
                            loading={resolving}
                            controlRef={(target) => { actionRef.current = target; }}
                            onPress={() => { void resolve(sourceId, 'use_source'); }} />}
                        {!outcome && !resolveError && selectedKeepAlternatives ? <RoundButton size="normal" display="inverted"
                            title={t('workspaceSync.review.keepAlternatives')}
                            disabled={!canResolve || resolving}
                            onPress={() => { void resolve(sourceId, 'keep_both'); }} /> : null}
                        {accountBinding?.isCurrent() && endpointFor(sourceId)?.workspaceRef?.rootPath
                            ? <RoundButton size="normal" display="inverted" title={t('workspaceSync.review.askAgent')}
                                onPress={askAgent} /> : null}
                    </View>
                </View> : null}
            </View>
    ) : null;

    const showPathList = !props.approvedRequest && (!selectedPath || splitComparison);
    return <View style={props.embedded ? undefined : { flex: 1, minHeight: 0, flexDirection: splitComparison && selectedPath ? 'row' : 'column' }}
        onLayout={(event) => {
            const width = event.nativeEvent.layout.width;
            setPaneWidth((previous) => previous === width ? previous : width);
        }}>
      {!props.approvedRequest ? <VirtualizedList
        ref={listRef}
        testID="workspace-sync-conflict-path-list"
        data={projection.rows}
        keyExtractor={(row) => row.path}
        estimatedItemSize={64}
        extraData={selectedPath}
        style={showPathList ? (splitComparison && selectedPath ? { width: 320, maxWidth: '40%' } : { flex: 1 }) : { display: 'none' }}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 }}
        onScroll={(event) => { if (showPathList) listScrollOffsetRef.current = event.nativeEvent.contentOffset.y; }}
        ListHeaderComponent={<>
            <ItemGroup title={t('workspaceSync.title')}>
                {summaries.map((summary) => {
                    const mode = resolveWorkspaceSyncModeTranslationKey(summary.relationship.mode);
                    const error = summary.status?.errorCode ? resolveWorkspaceSyncErrorTranslationKey(summary.status.errorCode) : null;
                    return <Item key={summary.relationshipId}
                        title={`${summary.alpha.label} · ${summary.beta.label}`}
                        subtitle={[summary.relationshipId === props.resource.initialRelationshipId ? t('workspaceSync.error.needsAttention') : null,
                            mode ? t(mode) : t('workspaceSync.unknownMode'), t(resolveWorkspaceSyncRelationshipStateLabel({
                            enabled: summary.relationship.enabled,
                            statusState: summary.status?.state,
                            errorCode: summary.status?.errorCode,
                            statusPhaseHasError: false,
                        })), error ? t(error) : null].filter(Boolean).join(' · ')}
                        mode="info" />;
                })}
            </ItemGroup>
        </>}
        renderItem={({ item: row, index }) => <ItemGroup
            title={index === 0 ? t('workspaceSync.conflictsTitle') : undefined}
            virtualizedSegment={{ first: index === 0, last: index === projection.rows.length - 1 }}>
          <Item title={row.path} accessibilityLabel={row.path} copy={row.path} titleLines={2}
            selected={row.path === selectedPath}
            pressableRef={(target: React.ComponentRef<typeof Pressable> | null) => {
                if (target && row.path === (selectedPath ?? returnedPathRef.current)) rowFocusRef.current = target;
            }}
            subtitle={t('workspaceSync.review.linkCount', { count: row.entries.length })}
            onPress={() => {
                reinspectAfterTerminalRef.current = false;
                setReinspectingTerminal(false);
                setSelectedPath(row.path); setSelectedTargetWorkspaceRefIds(null); setOutcome(null); setResolveError(null);
            }} />
        </ItemGroup>}
        ListFooterComponent={<>
            <ItemGroup title={projection.rows.length === 0 ? t('workspaceSync.conflictsTitle') : undefined}>
                {scopes.length > 0 && projection.coverage.complete && !invalidated && projection.rows.length === 0
                    ? <Item title={t('workspaceSync.noConflicts')} mode="info" /> : null}
                {scopes.length === 0 || !projection.coverage.complete || invalidated
                    ? <Item title={t('workspaceSync.review.coverageIncomplete')} mode="info" /> : null}
                {snapshots.flatMap(({ scope, snapshot }) => snapshot.hasMore ? [<Item key={`more:${scope.relationshipId}`}
                    title={t('workspaceSync.review.moreOnLink', { name: relationshipLabel(scope.relationshipId) })}
                    loading={snapshot.phase === 'loading_more' || snapshot.phase === 'refreshing'}
                    disabled={snapshot.phase === 'loading_more' || snapshot.phase === 'refreshing' || snapshot.phase === 'loading'}
                    onPress={() => void loadMoreWorkspaceSyncConflicts(scope).catch(() => undefined)} />] : [])}
                <Item title={t('workspaceSync.actions.refresh')} onPress={refresh} />
            </ItemGroup>
            <ItemGroup>
                <ExpandableItem testID="workspace-sync-conflict-diagnostics" expanded={diagnosticsExpanded}
                    onExpandedChange={setDiagnosticsExpanded} showDivider={false}
                    header={({ headerProps }) => <Item {...headerProps} title={t('workspaceSync.diagnostics.title')}
                        showChevron={false} />}>
                    <View>
                        <Item title={t('workspaceSync.diagnostics.controllerMachineId')} subtitle={props.resource.controllerMachineId} copy={props.resource.controllerMachineId} showChevron={false} />
                        {summaries.map((summary) => <Item key={summary.relationshipId}
                            title={t('workspaceSync.diagnostics.relationshipId')} subtitle={summary.relationshipId}
                            copy={summary.relationshipId} showChevron={false} />)}
                    </View>
                </ExpandableItem>
            </ItemGroup>
        </>}
      /> : null}
      {selectedDetail}
    </View>;
});
