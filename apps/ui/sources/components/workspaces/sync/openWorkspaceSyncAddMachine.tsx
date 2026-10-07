import * as React from 'react';
import { View } from 'react-native';
import type { WorkspaceSyncPersistentModeV1, WorkspaceSyncDestinationIntentV1 } from '@happier-dev/protocol';
import { evaluateSessionHandoffWorkspaceTransferSourcePathSafety } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
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
import {
    buildWorkspaceContentPolicy,
    parseSessionHandoffIgnoredIncludeGlobs,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { useMachineListByServerId, useMachineRecordValues } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { createWorkspaceSyncRelationship, approveWorkspaceSyncRelationshipCreate } from '@/sync/ops/workspaceSyncRelationshipCreate';
import { addWorkspaceRefToAccount } from '@/sync/ops/workspaceRefs';
import { workspaceListDirectory } from '@/sync/ops/workspaceFileSystem';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { randomUUID } from '@/platform/randomUUID';

import { WorkspaceActivationContentPolicyFields, WorkspaceActivationDestinationFields, WorkspaceActivationModeField } from '@/components/workspaces/activation/WorkspaceActivationEditor';

type SourceWorkspace = Readonly<{ id?: string; serverId: string; machineId: string; rootPath: string }>;
type AddMachineOperation = { inFlight: boolean; abortController: AbortController | null };
type AddMachineProps = CustomModalInjectedProps & Readonly<{
    source: SourceWorkspace;
    onOpenExisting: (summary: WorkspaceSyncRelationshipSummary) => void;
    operation: AddMachineOperation;
}>;

const modes: readonly WorkspaceSyncPersistentModeV1[] = ['keep_synced', 'mirror_exactly', 'keep_both_in_sync'];
const modeTitle = (mode: WorkspaceSyncPersistentModeV1) => t(
    mode === 'mirror_exactly' ? 'workspaceSync.addMachine.exactReplica'
        : mode === 'keep_both_in_sync' ? 'workspaceSync.addMachine.editableCopy'
            : 'workspaceSync.addMachine.replica',
);
const emptyPaths = [] as const;
const ignoreClose = () => {};

function WorkspaceSyncAddMachineModal(props: AddMachineProps) {
    const activeServer = useActiveServerSnapshot();
    const machineListByServerId = useMachineListByServerId();
    const activeMachines = useMachineRecordValues() ?? [];
    const summaries = useWorkspaceSyncRelationshipSummaries();
    const linkedSource = summaries.some((summary) => props.source.id
        && (summary.alpha.workspaceRefId === props.source.id || summary.beta.workspaceRefId === props.source.id));
    const hub = linkedSource
        ? selectWorkspaceSyncAddMachineHub(summaries, props.source.id ?? '')
        : props.source;
    const hubConflict = linkedSource && !hub;
    const allMachines = React.useMemo(() => resolveServerScopedMachines({
        serverId: props.source.serverId,
        serverIdAliases: getServerProfileLegacyServerIds(props.source.serverId),
        activeServerId: activeServer.serverId ?? '',
        activeMachines,
        machineListByServerId,
    }) ?? [], [activeMachines, activeServer.serverId, machineListByServerId, props.source.serverId]);
    const machines = React.useMemo(
        () => allMachines.filter((machine: Machine) => machine.id !== hub?.machineId && !machine.revokedAt),
        [allMachines, hub?.machineId],
    );
    const hubMachine = allMachines.find((machine: Machine) => machine.id === hub?.machineId);
    const hubMachineLabel = hubMachine ? getMachineDisplayName(hubMachine) : undefined;
    React.useEffect(() => {
        if (sync.getCredentials()) void sync.refreshMachinesThrottled({ force: true });
    }, [props.source.serverId]);

    const [machineId, setMachineId] = React.useState<string | null>(null);
    const [targetPath, setTargetPath] = React.useState('');
    const [mode, setMode] = React.useState<WorkspaceSyncPersistentModeV1>('keep_synced');
    const [destinationIntent, setDestinationIntent] = React.useState<WorkspaceSyncDestinationIntentV1>('use_existing');
    const [contentSelection, setContentSelection] = React.useState<'git_worktree' | 'all_files'>('git_worktree');
    const [includeIgnoredMode, setIncludeIgnoredMode] = React.useState<'exclude' | 'include_selected'>('exclude');
    const [patternsDraft, setPatternsDraft] = React.useState('');
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
    const homeDir = String(selectedMachine?.metadata?.homeDir ?? '').trim() || '/home';
    const resolvedPath = resolveAbsolutePath(targetPath.trim(), homeDir);
    const pathSafety = evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: resolvedPath,
        sourceHomeDir: homeDir,
    });
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

    const invalidateDraft = React.useCallback(() => {
        setPendingApprovalId(null);
        setPhase('idle');
        setError(null);
    }, []);
    const blockedReason = hubConflict || !hub
        ? t('workspaceSync.error.needsAttention')
        : !selectedMachine
        ? t('workspaceSync.start.blocked.targetMachine')
        : !canAttemptMachineSpawn({ machine: selectedMachine, selectedMachineId: machineId })
            ? t('workspaceSync.start.blocked.targetMachineOffline')
        : !targetPath.trim() || !pathSafety.allowed
            ? t('workspaceSync.start.blocked.destinationFolder')
            : null;
    const busy = phase === 'submitting' || phase === 'approving';

    const confirmAndApprove = React.useCallback(async (artifactId: string, signal: AbortSignal) => {
        if (signal.aborted) {
            setPhase('approval_pending');
            return;
        }
        const machineName = selectedMachine ? getMachineDisplayName(selectedMachine) : '';
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
                : caught instanceof Error ? caught.message : t('errors.operationFailed'));
            setPhase('approval_pending');
        }
    }, [destinationIntent, homeDir, mode, props.source.serverId, resolvedPath, selectedMachine]);

    const submit = React.useCallback(async () => {
        if (submissionInFlight.current || busy || phase === 'linked' || inspectRequired) return;
        if (existing) {
            props.onOpenExisting(existing);
            props.onClose();
            return;
        }
        if (blockedReason || !selectedMachine || !hub) return;
        submissionInFlight.current = true;
        const controller = new AbortController();
        props.operation.inFlight = true;
        props.operation.abortController = controller;
        try {
        if (pendingApprovalId) {
            await confirmAndApprove(pendingApprovalId, controller.signal);
            return;
        }
        setError(null);
        setPhase('submitting');
        let sourceWorkspaceRefId = hub.id ?? materializedSourceRefId;
        if (!sourceWorkspaceRefId) {
            try {
                const preflight = await workspaceListDirectory({
                    serverId: props.source.serverId,
                    machineId: props.source.machineId,
                    rootPath: props.source.rootPath,
                }, '');
                if (!preflight.success) throw new Error(preflight.error);
                const nowMs = Date.now();
                const added = await addWorkspaceRefToAccount({
                    scope: {
                        serverId: props.source.serverId,
                        machineId: props.source.machineId,
                        rootPath: props.source.rootPath,
                    },
                    nowMs,
                    patch: { lastOpenedAtMs: nowMs },
                });
                if (!added.ok || !('workspaceRefId' in added) || typeof added.workspaceRefId !== 'string') {
                    if (!added.ok && added.code === 'workspace_settings_outcome_unknown') setInspectRequired(true);
                    throw new Error(t('common.saveError'));
                }
                sourceWorkspaceRefId = added.workspaceRefId;
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
            targetMachineId: selectedMachine.id,
            targetPath: resolvedPath,
            mode,
            destinationIntent,
            contentPolicy: buildWorkspaceContentPolicy({
                contentSelection,
                includeIgnoredMode,
                ignoredIncludeGlobs: parseSessionHandoffIgnoredIncludeGlobs(patternsDraft),
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
            if (controller.signal.aborted || (caught && typeof caught === 'object' && 'code' in caught
                && (caught.code === 'indeterminate' || caught.code === 'approval_execution_outcome_unknown'))) {
                setInspectRequired(true);
            }
            setError(controller.signal.aborted
                ? t('workspaceSync.error.needsAttention')
                : caught instanceof Error ? caught.message : t('errors.operationFailed'));
            setPhase('idle');
        }
        } finally {
            submissionInFlight.current = false;
            props.operation.inFlight = false;
            props.operation.abortController = null;
        }
    }, [blockedReason, busy, confirmAndApprove, contentSelection, destinationIntent, existing, hub, includeIgnoredMode, inspectRequired, materializedSourceRefId, mode, patternsDraft, pendingApprovalId, phase, props, resolvedPath, selectedMachine]);

    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={t(phase === 'linked' ? 'common.done' : 'common.cancel')} onPress={props.onClose} />
            <RoundButton
                testID="workspace-sync-add-machine-submit"
                title={existing ? t('workspaceSync.diagnostics.title') : pendingApprovalId ? t('sessionHandoff.targetApproval.title') : t('settings.addMachine')}
                onPress={() => void submit()}
                disabled={Boolean(blockedReason) || busy || phase === 'linked' || inspectRequired}
                accessibilityHint={blockedReason ?? undefined}
            />
        </View>
    ), [blockedReason, busy, existing, inspectRequired, pendingApprovalId, phase, props.onClose, submit]);
    const chrome = React.useMemo(() => ({
        kind: 'card',
        title: t('settings.addMachine'),
        subtitle: t('workspaceSync.title'),
        testID: 'workspace-sync-add-machine-modal',
        dimensions: { width: 540, maxHeightRatio: 0.92 },
        footer,
    } as const), [footer]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ItemList presentation="grouped" keyboardAware style={{ paddingTop: 0 }}>
            {hub ? <Item
                title={t('workspaceSync.endpoint.source', {
                    label: formatPathRelativeToHome(hub.rootPath, hubMachine?.metadata?.homeDir ?? undefined),
                })}
                detail={hubMachineLabel}
                mode="info"
            /> : null}
            <WorkspaceActivationDestinationFields
                machine={{
                    machines, selectedMachine, showSearch: true, presentation: 'dropdown',
                    showCliGlyphs: false, autoDetectCliGlyphs: false, disableOfflineMachines: true,
                    testIdPrefix: 'workspace-sync-add-machine',
                    onSelect: (machine) => { setMachineId(machine.id); setTargetPath(''); invalidateDraft(); },
                }}
                path={{
                    machineHomeDir: homeDir, initialValue: targetPath, initialSuggestionMode: 'history',
                    favorites: emptyPaths, recents: emptyPaths, machineId,
                    serverId: props.source.serverId,
                    machinePlatform: machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform),
                    onCommit: (path) => { setTargetPath(path); invalidateDraft(); },
                    onChangeDraftPath: (path) => { setTargetPath(path); invalidateDraft(); },
                    onRequestClose: ignoreClose,
                }}
                pathTitle={t('settingsSession.handoff.targetBootstrap.title')}
                blockedReason={blockedReason}
            />
            <ItemGroup title={t('settingsSession.handoff.workspaceMode.title')}>
                <WorkspaceActivationModeField
                    open={openMenu === 'mode'} onOpenChange={(open) => setOpenMenu(open ? 'mode' : null)}
                    selectedId={mode} title={t('settingsSession.handoff.workspaceMode.title')} subtitle={modeTitle(mode)}
                    items={modes.map((value) => ({ id: value, title: modeTitle(value), subtitle: t(value === 'mirror_exactly' ? 'settingsSession.handoff.workspaceMode.mirrorExactlySubtitle' : value === 'keep_both_in_sync' ? 'settingsSession.handoff.workspaceMode.keepBothInSyncSubtitle' : 'settingsSession.handoff.workspaceMode.keepSyncedSubtitle') }))}
                    onSelect={(value) => { setMode(value as WorkspaceSyncPersistentModeV1); setOpenMenu(null); invalidateDraft(); }}
                />
                {mode === 'keep_both_in_sync' ? <Item title={t('workspaceSync.addMachine.editableCopyHint')} mode="info" /> : null}
                <WorkspaceActivationModeField
                    open={openMenu === 'destination'} onOpenChange={(open) => setOpenMenu(open ? 'destination' : null)}
                    selectedId={destinationIntent} title={t('settingsSession.handoff.targetBootstrap.title')}
                    subtitle={t(destinationIntent === 'use_existing' ? 'settingsSession.handoff.targetBootstrap.useExistingSubtitle' : 'settingsSession.handoff.targetBootstrap.materializeSubtitle')}
                    items={[
                        { id: 'use_existing', title: t('settingsSession.handoff.targetBootstrap.useExistingTitle'), subtitle: t('settingsSession.handoff.targetBootstrap.useExistingSubtitle') },
                        { id: 'materialize_from_source_workspace', title: t('settingsSession.handoff.targetBootstrap.materializeTitle'), subtitle: t('settingsSession.handoff.targetBootstrap.materializeSubtitle') },
                    ]}
                    onSelect={(value) => { setDestinationIntent(value as WorkspaceSyncDestinationIntentV1); setOpenMenu(null); invalidateDraft(); }}
                />
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
            {existing ? <Item title={t('settingsSession.handoff.workspaceMode.relationshipSelected')} mode="info" /> : null}
            {phase === 'approval_pending' ? <Text accessibilityLiveRegion="polite">{t('sessionHandoff.targetApproval.title')}</Text> : null}
            {phase === 'submitting' || phase === 'approving' ? <Text accessibilityLiveRegion="polite">{t('workspaceSync.state.working')}</Text> : null}
            {phase === 'linked' ? <Text accessibilityLiveRegion="polite">{linkedConflictCount ? t('workspaceSync.conflictCount', { count: linkedConflictCount }) : t('workspaceSync.state.watching')}</Text> : null}
            {phase === 'linked' && linkedConflictCount && existing ? (
                <Item
                    title={t('workspaceSync.openConflicts', { count: linkedConflictCount })}
                    onPress={() => { props.onOpenExisting(existing); props.onClose(); }}
                    showChevron={true}
                />
            ) : null}
            {error ? <Text accessibilityLiveRegion="polite">{error}</Text> : null}
            {inspectRequired ? <Item title={t('workspaceSync.diagnostics.title')} subtitle={t('workspaceSync.error.needsAttention')} onPress={props.onClose} showChevron={true} /> : null}
        </ItemList>
    );
}

export function openWorkspaceSyncAddMachine(source: SourceWorkspace, onOpenExisting: (summary: WorkspaceSyncRelationshipSummary) => void): void {
    const operation: AddMachineOperation = { inFlight: false, abortController: null };
    Modal.show({
        component: WorkspaceSyncAddMachineModal,
        props: { source, onOpenExisting, operation },
        accessibilityLabel: t('settings.addMachine'),
        closeOnBackdrop: true,
        onDismissRequest: () => {
            if (!operation.inFlight) return true;
            operation.abortController?.abort();
            return false;
        },
        onHostUnmount: () => operation.abortController?.abort(),
    });
}
