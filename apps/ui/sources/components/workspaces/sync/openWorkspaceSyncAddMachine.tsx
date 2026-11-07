import * as React from 'react';
import { View } from 'react-native';
import type { WorkspaceSyncPersistentModeV1, WorkspaceSyncDestinationIntentV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { evaluateSessionHandoffWorkspaceTransferSourcePathSafety } from '@happier-dev/protocol/sessions/control/handoff/workspaceTransferSourcePathSafety';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ProjectWorkerNoAcceptanceFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { projectOpenRefusalPresentation } from '@/components/projects/activation/projectOpenRefusalPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard, type SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';
import type { CustomModalInjectedProps } from '@/modal';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getServerProfileLegacyServerIds } from '@/sync/domains/server/serverProfiles';
import {
    selectWorkspaceSyncAddMachineHub,
    type WorkspaceSyncRelationshipSummary,
} from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { useWorkspaceSyncRelationshipSummaries } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { presentWorkspaceSyncFailure, readWorkspaceSyncErrorCode } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import {
    buildWorkspaceContentPolicy,
    parseSessionHandoffIgnoredIncludeGlobs,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { useMachineListStatusByServerId, useMachineRecordValues, useMachineListByServerId } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { createWorkspaceSyncRelationship, approveWorkspaceSyncRelationshipCreate } from '@/sync/ops/workspaceSyncRelationshipCreate';
import { useWorkspaceSyncTargetFolderState } from './useWorkspaceSyncTargetFolderState';
import { useWorkspaceSyncRequesterAvailability } from '@/hooks/machine/useWorkspaceSyncRequesterAvailability';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { randomUUID } from '@/platform/randomUUID';

import { WorkspaceActivationContentPolicyFields, WorkspaceActivationDestinationFields, WorkspaceActivationModeField } from '@/components/workspaces/activation/WorkspaceActivationEditor';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

type SourceWorkspace = Readonly<{ serverId: string; machineId: string }> & (
    Readonly<{ id?: string; rootPath: string }> | Readonly<{ id: string; rootPath?: string }>
);
type AddMachineOperation = { inFlight: boolean; abortController: AbortController | null };
type AddMachineOptions = Readonly<{ targetMachineId?: string; purpose?: 'worker_clean_copy'; replace?: WorkspaceSyncRelationshipSummary }>;
type AddMachineProps = CustomModalInjectedProps & Readonly<{
    source: SourceWorkspace;
    onOpenExisting: (summary: WorkspaceSyncRelationshipSummary) => void;
    operation: AddMachineOperation;
    options: AddMachineOptions;
}>;

const modes: readonly WorkspaceSyncPersistentModeV1[] = ['keep_synced', 'mirror_exactly', 'keep_both_in_sync'];
const modeTitle = (mode: WorkspaceSyncPersistentModeV1) => t(
    mode === 'mirror_exactly' ? 'workspaceSync.addMachine.exactReplica'
        : mode === 'keep_both_in_sync' ? 'workspaceSync.addMachine.editableCopy'
            : 'workspaceSync.addMachine.replica',
);
const emptyPaths = [] as const;
const ignoreClose = () => {};

/**
 * The one status line under the form: what a failure says wins, then the step in flight, then the
 * outcome. Tone and the live region come from the shared state line (danger for a failure, an alert
 * announcement for it).
 */
function resolveStatusLine(input: Readonly<{
    error: string | null;
    phase: 'idle' | 'submitting' | 'approval_pending' | 'approving' | 'linked';
    linkedConflictCount: number | null;
}>): Readonly<{ kind: SurfaceStateKind; title: string; announce: 'status' | 'alert' }> | null {
    if (input.error) return { kind: 'error', title: input.error, announce: 'alert' };
    if (input.phase === 'approval_pending') {
        return { kind: 'warning', title: t('workspaceSync.addMachine.awaitingApproval'), announce: 'status' };
    }
    if (input.phase === 'submitting' || input.phase === 'approving') {
        return { kind: 'loading', title: t('workspaceSync.state.working'), announce: 'status' };
    }
    if (input.phase === 'linked') {
        return input.linkedConflictCount
            ? { kind: 'warning', title: t('workspaceSync.conflictCount', { count: input.linkedConflictCount }), announce: 'status' }
            : { kind: 'success', title: t('workspaceSync.state.watching'), announce: 'status' };
    }
    return null;
}

function WorkspaceSyncAddMachineModal(props: AddMachineProps) {
    const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    useMachineReachabilityRevision();
    const activeServer = useActiveServerSnapshot();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeMachines = useMachineRecordValues() ?? [];
    const summaries = useWorkspaceSyncRelationshipSummaries(undefined, props.source.serverId);
    const sourceRef = useProjectAccountWorkspaceRef(props.source.rootPath === undefined ? props.source.id ?? null : null, props.source.serverId);
    const source = props.source.rootPath !== undefined
        ? { ...props.source, rootPath: props.source.rootPath }
        : sourceRef?.machineId === props.source.machineId ? sourceRef : null;
    const linkedSource = summaries.some((summary) => props.source.id
        && (summary.alpha.workspaceRefId === props.source.id || summary.beta.workspaceRefId === props.source.id));
    const hub = linkedSource
        ? selectWorkspaceSyncAddMachineHub(summaries, props.source.id ?? '')
        : source;
    const hubConflict = linkedSource && !hub;
    const allMachines = React.useMemo(() => resolveServerScopedMachines({
        serverId: props.source.serverId,
        serverIdAliases: getServerProfileLegacyServerIds(props.source.serverId),
        activeServerId: activeServer.serverId ?? '',
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId,
    }) ?? [], [activeMachines, activeServer.serverId, machineListByServerId, machineListStatusByServerId, props.source.serverId]);
    // The source's own Machine stays listed: Workspace Sync links distinct roots on one Machine too.
    const machines = React.useMemo(
        () => allMachines.filter((machine: Machine) => !machine.revokedAt),
        [allMachines],
    );
    const hubMachineId = hub?.machineId;
    const describeMachine = React.useCallback(
        (machine: Machine) => machine.id === hubMachineId ? t('workspaceSync.addMachine.thisMachine') : null,
        [hubMachineId],
    );
    const hubMachine = allMachines.find((machine: Machine) => machine.id === hub?.machineId);
    const hubMachineLabel = hubMachine ? getMachineDisplayName(hubMachine) : undefined;
    React.useEffect(() => {
        if (sync.getCredentials()) void sync.refreshMachinesThrottled({ force: true });
    }, [props.source.serverId]);

    const [machineId, setMachineId] = React.useState<string | null>(props.options.targetMachineId ?? null);
    const replacement = props.options.replace;
    const [targetPath, setTargetPath] = React.useState(replacement?.beta.workspaceRef?.rootPath ?? '');
    const [mode, setMode] = React.useState<WorkspaceSyncPersistentModeV1>(replacement?.relationship.mode ?? 'keep_synced');
    const [chosenDestinationIntent, setDestinationIntent] = React.useState<WorkspaceSyncDestinationIntentV1>(
        props.options.purpose === 'worker_clean_copy' ? 'materialize_from_source_workspace' : 'use_existing');
    const [contentSelection, setContentSelection] = React.useState<'git_worktree' | 'all_files'>(replacement?.relationship.contentPolicy.selection ?? 'git_worktree');
    const [includeIgnoredMode, setIncludeIgnoredMode] = React.useState<'exclude' | 'include_selected'>(replacement?.relationship.contentPolicy.extraIncludePatterns.length ? 'include_selected' : 'exclude');
    const [patternsDraft, setPatternsDraft] = React.useState(replacement?.relationship.contentPolicy.extraIncludePatterns.join('\n') ?? '');
    const [openMenu, setOpenMenu] = React.useState<'mode' | 'destination' | null>(null);
    const [advancedExpanded, setAdvancedExpanded] = React.useState(false);
    const [pendingApprovalId, setPendingApprovalId] = React.useState<string | null>(null);
    const [phase, setPhase] = React.useState<'idle' | 'submitting' | 'approval_pending' | 'approving' | 'linked'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const [inspectRequired, setInspectRequired] = React.useState(false);
    const [linkedConflictCount, setLinkedConflictCount] = React.useState<number | null>(null);
    const [materializedSourceRefId, setMaterializedSourceRefId] = React.useState<string | null>(props.source.id ?? null);
    const requestIdentity = React.useRef<{ fingerprint: string; id: string } | null>(null);
    const submissionInFlight = React.useRef(false);

    const selectedMachine = machines.find((machine: Machine) => machine.id === machineId) ?? null;
    const sourceAvailability = useWorkspaceSyncRequesterAvailability({ serverId: props.source.serverId, machineId: hub?.machineId });
    const destinationAvailability = useWorkspaceSyncRequesterAvailability({ serverId: props.source.serverId,
        machineId: selectedMachine?.id === hub?.machineId ? null : selectedMachine?.id });
    const targetAvailability = selectedMachine?.id === hub?.machineId ? sourceAvailability : destinationAvailability;
    const sourceRoots = sourceAvailability?.kind === 'available' ? sourceAvailability : null;
    const targetRoots = targetAvailability?.kind === 'available' ? targetAvailability : null;
    const homeDir = targetRoots?.homeDir ?? '';
    const resolvedPath = resolveAbsolutePath(targetPath.trim(), homeDir);
    const pathSafety = evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: resolvedPath,
        sourceHomeDir: homeDir,
    });
    const insideSource = Boolean(hub && selectedMachine?.id === hub.machineId
        && resolvePathRelativeToRoot({ path: resolvedPath, root: hub.rootPath }) !== null);
    const targetKey = selectedMachine && resolvedPath
        ? tryBuildWorkspaceCacheKey({ serverId: props.source.serverId, machineId: selectedMachine.id, rootPath: resolvedPath })
        : null;
    const existing = targetKey ? summaries.find((summary) => {
        const hubId = hub?.id ?? materializedSourceRefId;
        const other = summary.alpha.workspaceRefId === hubId ? summary.beta
            : summary.beta.workspaceRefId === hubId ? summary.alpha
                : null;
        return other?.workspaceRef && tryBuildWorkspaceCacheKey(other.workspaceRef) === targetKey;
    }) ?? null : null;

    // A Git link needs a checkout already in the folder to "use"; an empty or missing folder can only be
    // prepared, so that is the effective choice while the folder is such (the person's own choice returns
    // when the folder changes).
    const folderChoiceValid = !targetRoots || !targetPath.trim() || !pathSafety.allowed || insideSource ? null : resolvedPath;
    const targetFolderState = useWorkspaceSyncTargetFolderState({
        machineId: selectedMachine?.id ?? null, serverId: props.source.serverId, path: folderChoiceValid,
    });
    const useExistingNeedsFiles = contentSelection === 'git_worktree'
        && (targetFolderState === 'missing' || targetFolderState === 'empty');
    const destinationIntent: WorkspaceSyncDestinationIntentV1 = replacement ? 'use_existing' : useExistingNeedsFiles
        ? 'materialize_from_source_workspace' : chosenDestinationIntent;

    const invalidateDraft = React.useCallback(() => {
        setPendingApprovalId(null);
        setPhase('idle');
        setError(null);
    }, []);
    const blockedReason = hubConflict || !hub
        ? t('workspaceSync.error.needsAttention')
        : !selectedMachine
        ? t('workspaceSync.start.blocked.targetMachine')
        : !canAttemptMachineSpawn({ machine: selectedMachine, selectedMachineId: machineId, scope })
            ? t('workspaceSync.start.blocked.targetMachineOffline')
        : !sourceRoots || !targetRoots
            ? t('workspaceSync.error.needsAttention')
        : !targetPath.trim() || !pathSafety.allowed || insideSource
            ? t('workspaceSync.start.blocked.destinationFolder')
            : null;
    const busy = phase === 'submitting' || phase === 'approving';
    const statusLine = resolveStatusLine({ error, phase, linkedConflictCount });

    const confirmAndApprove = React.useCallback(async (artifactId: string, signal: AbortSignal) => {
        if (signal.aborted) {
            setPhase('approval_pending');
            return;
        }
        const machineName = selectedMachine ? getMachineSentenceName(selectedMachine) : '';
        const pathLabel = formatPathRelativeToHome(resolvedPath, homeDir);
        const consequence = destinationIntent === 'materialize_from_source_workspace'
            ? t('sessionHandoff.targetApproval.replaceTarget', { machine: machineName, path: pathLabel })
            : t('settingsSession.handoff.targetBootstrap.useExistingSubtitle');
        const exactMirrorConsequence = mode === 'mirror_exactly'
            ? `\n${t('sessionHandoff.targetApproval.exactMirror', { machine: machineName, path: pathLabel })}`
            : '';
        const accepted = await Modal.confirm(
            t('sessionHandoff.targetApproval.title'),
            `${consequence}${exactMirrorConsequence}`,
            {
                cancelText: t('common.cancel'),
                confirmText: mode === 'mirror_exactly'
                    ? t('sessionHandoff.targetApproval.decision.mirrorAndAllowRemovals')
                    : t('sessionHandoff.targetApproval.decision.replaceDestination'),
                destructive: true,
            },
        );
        if (!accepted || signal.aborted) {
            setPhase('approval_pending');
            return;
        }
        setPhase('approving');
        try {
            const result = await approveWorkspaceSyncRelationshipCreate({ artifactId, serverId: props.source.serverId, signal });
            setPendingApprovalId(null);
            setLinkedConflictCount(result.status.conflictCount);
            setPhase('linked');
        } catch (caught) {
            if (signal.aborted || (caught && typeof caught === 'object' && 'code' in caught
                && (caught.code === 'indeterminate' || caught.code === 'approval_execution_outcome_unknown'))) {
                setInspectRequired(true);
            }
            setError(signal.aborted
                ? t('workspaceSync.error.needsAttention')
                : presentWorkspaceSyncFailure(caught) ?? (caught instanceof Error ? caught.message : t('errors.operationFailed')));
            setPhase('approval_pending');
        }
    }, [destinationIntent, homeDir, mode, props.source.serverId, resolvedPath, selectedMachine]);

    const submit = React.useCallback(async () => {
        if (submissionInFlight.current || busy || phase === 'linked' || inspectRequired) return;
        if (!binding?.isCurrent()) return;
        if (existing && !replacement) {
            props.onOpenExisting(existing);
            props.onClose();
            return;
        }
        if (blockedReason || !selectedMachine || !hub) return;
        submissionInFlight.current = true;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        props.operation.inFlight = true;
        props.operation.abortController = controller;
        try {
        if (pendingApprovalId) {
            await confirmAndApprove(pendingApprovalId, controller.signal);
            return;
        }
        if (replacement && !await Modal.confirm(
            t('workspaceSync.replace.title'), t('workspaceSync.replace.confirm'),
            { cancelText: t('common.cancel'), confirmText: t('workspaceSync.replace.action'), destructive: true },
        )) return;
        setError(null);
        setPhase('submitting');
        let sourceWorkspaceRefId = hub.id ?? materializedSourceRefId;
        if (!sourceWorkspaceRefId) {
            try {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const opened = await createDefaultActionExecutor().execute('projects.open', {
                    serverId: props.source.serverId, machineId: props.source.machineId,
                    source: { kind: 'folder', path: hub.rootPath }, materialization: { kind: 'attach' },
                }, { surface: 'ui', serverId: props.source.serverId, signal: controller.signal });
                if (!opened.ok) {
                    // A declined approval ran nothing: the person answered, nothing failed.
                    if (isActionApprovalDeclinedErrorCode(opened.errorCode)) { setPhase('idle'); return; }
                    throw new Error(t('common.saveError'));
                }
                const accepted = OpenProjectResultV1Schema.parse(opened.result);
                if (accepted.kind === 'refused') throw new Error(projectOpenRefusalPresentation(accepted.code, null).title);
                if (accepted.kind === 'outcomeUnknown') setInspectRequired(true);
                if (accepted.kind !== 'opened' || accepted.workspace.serverId !== props.source.serverId
                    || accepted.workspace.machineId !== props.source.machineId) throw new Error(t('common.saveError'));
                sourceWorkspaceRefId = accepted.workspace.workspaceId;
                setMaterializedSourceRefId(sourceWorkspaceRefId);
            } catch (caught) {
                setError(caught instanceof Error ? caught.message : t('errors.operationFailed'));
                setPhase('idle');
                return;
            }
        }
        if (controller.signal.aborted) {
            setPhase('idle');
            return;
        }
        const input = {
            v: 1 as const,
            sourceWorkspaceRefId,
            ...(replacement ? { replaceRelationshipId: replacement.relationship.relationshipId } : {}),
            targetMachineId: selectedMachine.id,
            targetPath: resolvedPath,
            mode,
            destinationIntent,
            ...(props.options.purpose ? { purpose: props.options.purpose } : {}),
            contentPolicy: buildWorkspaceContentPolicy({
                contentSelection,
                includeIgnoredMode,
                ignoredIncludeGlobs: parseSessionHandoffIgnoredIncludeGlobs(patternsDraft),
                ...(replacement ? { extraIgnorePatterns: replacement.relationship.contentPolicy.extraIgnorePatterns } : {}),
            }),
        };
        const fingerprint = JSON.stringify(input);
        if (requestIdentity.current?.fingerprint !== fingerprint) {
            requestIdentity.current = { fingerprint, id: randomUUID() };
        }
        try {
            const outcome = await createWorkspaceSyncRelationship({
                input,
                serverId: props.source.serverId,
                actionRequestId: requestIdentity.current.id,
                signal: controller.signal,
            });
            if (outcome.kind === 'approval_required') {
                setPendingApprovalId(outcome.artifactId);
                setPhase('approval_pending');
                await confirmAndApprove(outcome.artifactId, controller.signal);
                return;
            }
            setLinkedConflictCount(outcome.result.status.conflictCount);
            setPhase('linked');
        } catch (caught) {
            if (!controller.signal.aborted && isActionApprovalDeclinedErrorCode(readWorkspaceSyncErrorCode(caught))) {
                setPhase('idle');
                return;
            }
            if (controller.signal.aborted || (caught && typeof caught === 'object' && 'code' in caught
                && (caught.code === 'indeterminate' || caught.code === 'approval_execution_outcome_unknown'))) {
                setInspectRequired(true);
            }
            setError(controller.signal.aborted
                ? t('workspaceSync.error.needsAttention')
                : presentWorkspaceSyncFailure(caught) ?? (caught instanceof Error ? caught.message : t('errors.operationFailed')));
            setPhase('idle');
        }
        } finally {
            retirement.dispose();
            submissionInFlight.current = false;
            props.operation.inFlight = false;
            props.operation.abortController = null;
        }
    }, [binding, blockedReason, busy, confirmAndApprove, contentSelection, destinationIntent, existing, hub, includeIgnoredMode, inspectRequired, materializedSourceRefId, mode, patternsDraft, pendingApprovalId, phase, props, resolvedPath, selectedMachine]);

    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={t(phase === 'linked' ? 'common.done' : 'common.cancel')} onPress={props.onClose} />
            <RoundButton
                testID="workspace-sync-add-machine-submit"
                title={replacement ? t('workspaceSync.replace.action') : existing ? t('workspaceSync.diagnostics.title') : pendingApprovalId ? t('sessionHandoff.targetApproval.title') : t('settings.addMachine')}
                onPress={() => void submit()}
                disabled={Boolean(blockedReason) || busy || phase === 'linked' || inspectRequired}
                accessibilityHint={blockedReason ?? undefined}
            />
        </View>
    ), [blockedReason, busy, existing, inspectRequired, pendingApprovalId, phase, props.onClose, submit]);
    const chrome = React.useMemo(() => ({
        kind: 'card',
        title: t(replacement ? 'workspaceSync.replace.title' : 'settings.addMachine'),
        subtitle: t('workspaceSync.title'),
        testID: 'workspace-sync-add-machine-modal',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92 },
        footer,
    } as const), [footer, replacement]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ItemList presentation="grouped" keyboardAware style={{ paddingTop: 0 }}>
            {hub ? <Item
                title={t('workspaceSync.endpoint.source', {
                    label: formatPathRelativeToHome(hub.rootPath, sourceRoots?.homeDir),
                })}
                detail={hubMachineLabel}
                mode="info"
            /> : null}
            {replacement ? <Item title={t('settingsSession.handoff.targetBootstrap.title')} subtitle={replacement.beta.workspaceRef?.rootPath} mode="info" /> : <WorkspaceActivationDestinationFields
                machine={{
                    machines, selectedMachine, serverId: props.source.serverId, showSearch: true, presentation: 'dropdown',
                    showCliGlyphs: false, autoDetectCliGlyphs: false, disableOfflineMachines: true, describeMachine,
                    ...(selectedMachine ? {} : { dropdownSubtitle: t('workspaceSync.addMachine.machineHint') }),
                    testIdPrefix: 'workspace-sync-add-machine',
                    onSelect: (machine) => { setMachineId(machine.id); setTargetPath(''); invalidateDraft(); },
                }}
                path={{
                    machineHomeDir: homeDir, initialValue: targetPath, initialSuggestionMode: 'history',
                    favorites: emptyPaths, recents: emptyPaths, machineId: targetRoots ? machineId : null,
                    browseStartPath: targetRoots?.workspaceRoot ?? undefined,
                    serverId: props.source.serverId,
                    machinePlatform: machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform),
                    onCommit: (path) => { setTargetPath(path); invalidateDraft(); },
                    onChangeDraftPath: (path) => { setTargetPath(path); invalidateDraft(); },
                    onRequestClose: ignoreClose,
                }}
                pathTitle={t('settingsSession.handoff.targetBootstrap.title')}
                blockedReason={blockedReason}
            />}
            <ItemGroup>
                <WorkspaceActivationModeField
                    open={openMenu === 'mode'} onOpenChange={(open) => setOpenMenu(open ? 'mode' : null)}
                    selectedId={mode} title={t('sessionHandoff.targetApproval.modeLabel')} subtitle={modeTitle(mode)}
                    items={modes.map((value) => ({ id: value, title: modeTitle(value), subtitle: t(value === 'mirror_exactly' ? 'settingsSession.handoff.workspaceMode.mirrorExactlySubtitle' : value === 'keep_both_in_sync' ? 'settingsSession.handoff.workspaceMode.keepBothInSyncSubtitle' : 'settingsSession.handoff.workspaceMode.keepSyncedSubtitle') }))}
                    onSelect={(value) => { setMode(value as WorkspaceSyncPersistentModeV1); setOpenMenu(null); invalidateDraft(); }}
                />
                {mode === 'keep_both_in_sync' ? <Item title={t('workspaceSync.addMachine.editableCopyHint')} mode="info" /> : null}
                {replacement ? null : <WorkspaceActivationModeField
                    open={openMenu === 'destination'} onOpenChange={(open) => setOpenMenu(open ? 'destination' : null)}
                    selectedId={destinationIntent} title={t('workspaceSync.addMachine.folderSetup')}
                    subtitle={t(destinationIntent === 'use_existing' ? 'settingsSession.handoff.targetBootstrap.useExistingSubtitle' : 'settingsSession.handoff.targetBootstrap.materializeSubtitle')}
                    items={[
                        { id: 'use_existing', title: t('settingsSession.handoff.targetBootstrap.useExistingTitle'),
                            subtitle: useExistingNeedsFiles ? t('settingsSession.handoff.targetBootstrap.useExistingUnavailable') : t('settingsSession.handoff.targetBootstrap.useExistingSubtitle'),
                            disabled: useExistingNeedsFiles },
                        { id: 'materialize_from_source_workspace', title: t('settingsSession.handoff.targetBootstrap.materializeTitle'), subtitle: t('settingsSession.handoff.targetBootstrap.materializeSubtitle') },
                    ]}
                    onSelect={(value) => { setDestinationIntent(value as WorkspaceSyncDestinationIntentV1); setOpenMenu(null); invalidateDraft(); }}
                />}
            </ItemGroup>
            <ExpandableItem
                expanded={advancedExpanded}
                onExpandedChange={setAdvancedExpanded}
                header={(state) => <Item {...state.headerProps} title={t('settingsSession.handoff.advanced.title')} subtitle={t('settingsSession.handoff.advanced.subtitle')} showChevron={true} />}
            >
                <WorkspaceActivationContentPolicyFields
                    contentSelection={contentSelection}
                    onContentSelectionChange={(value) => { setContentSelection(value); invalidateDraft(); }}
                    includeIgnoredMode={includeIgnoredMode}
                    onIncludeIgnoredModeChange={(value) => { setIncludeIgnoredMode(value); invalidateDraft(); }}
                    patternsDraft={patternsDraft}
                    onPatternsDraftChange={(value) => { setPatternsDraft(value); invalidateDraft(); }}
                    testIdPrefix="workspace-sync-add-machine"
                />
            </ExpandableItem>
            {existing && !replacement ? <Item title={t('settingsSession.handoff.workspaceMode.relationshipSelected')} mode="info" /> : null}
            {statusLine ? (
                <SurfaceStateCard
                    testID="workspace-sync-add-machine-status"
                    size="line"
                    kind={statusLine.kind}
                    title={statusLine.title}
                    accessibilitySemantics={statusLine.announce}
                />
            ) : null}
            {phase === 'linked' && linkedConflictCount && existing ? (
                <Item
                    title={t('workspaceSync.openConflicts', { count: linkedConflictCount })}
                    onPress={() => { props.onOpenExisting(existing); props.onClose(); }}
                    showChevron={true}
                />
            ) : null}
            {inspectRequired ? <Item title={t('workspaceSync.diagnostics.title')} subtitle={t('workspaceSync.error.needsAttention')} onPress={props.onClose} showChevron={true} /> : null}
        </ItemList>
    );
}

export function openWorkspaceSyncAddMachine(source: SourceWorkspace, onOpenExisting: (summary: WorkspaceSyncRelationshipSummary) => void,
    options: AddMachineOptions = {}): void {
    const operation: AddMachineOperation = { inFlight: false, abortController: null };
    Modal.show({
        component: WorkspaceSyncAddMachineModal,
        props: { source, onOpenExisting, operation, options },
        accessibilityLabel: t(options.replace ? 'workspaceSync.replace.title' : 'settings.addMachine'),
        closeOnBackdrop: true,
        onDismissRequest: () => {
            if (!operation.inFlight) return true;
            operation.abortController?.abort();
            return false;
        },
        onHostUnmount: () => operation.abortController?.abort(),
    });
}

/** U3's explicit recovery action opens Sync's incumbent creator; it never retries Run. */
export function openWorkspaceSyncWorkerCopySetup(workspace: Pick<WorkspaceAddressV1, 'serverId' | 'workspaceId' | 'machineId'>
    & Partial<Pick<WorkspaceAddressV1, 'rootPath'>>, refusal: unknown,
    onOpenExisting: (summary: WorkspaceSyncRelationshipSummary) => void): boolean {
    const parsed = ProjectWorkerNoAcceptanceFailureDetailsV1Schema.safeParse(refusal);
    if (!parsed.success || parsed.data.reason !== 'worker_copy_missing' || !parsed.data.workerCopy) return false;
    const facts = parsed.data.workerCopy;
    if (facts.serverId !== workspace.serverId || facts.sourceWorkspaceRefId !== workspace.workspaceId
        || facts.sourceMachineId !== workspace.machineId) return false;
    openWorkspaceSyncAddMachine({ id: workspace.workspaceId, serverId: workspace.serverId,
        machineId: workspace.machineId, rootPath: workspace.rootPath }, onOpenExisting,
        { targetMachineId: facts.targetMachineId, purpose: 'worker_clean_copy' });
    return true;
}

/** Immutable mode and policy changes always use the explicit replacement Action. */
export function openWorkspaceSyncReplaceRelationship(summary: WorkspaceSyncRelationshipSummary,
    onOpenExisting: (summary: WorkspaceSyncRelationshipSummary) => void): void {
    const source = summary.alpha.workspaceRef;
    const target = summary.beta.workspaceRef;
    if (!source || !target) return;
    openWorkspaceSyncAddMachine(source, onOpenExisting, {
        targetMachineId: target.machineId,
        ...(summary.relationship.provenance?.kind === 'worker_clean_copy' ? { purpose: 'worker_clean_copy' } : {}),
        replace: summary,
    });
}
