import { useMachineFavorites } from '@/sync/store/settingsWriters';
import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import * as React from 'react';
import { View } from 'react-native';
import { evaluateSessionHandoffWorkspaceTransferSourcePathSafety } from '@happier-dev/protocol/sessions/control/handoff/workspaceTransferSourcePathSafety';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { HandoffWorkspaceActionV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    buildSessionHandoffWorkspaceAction,
    normalizeSessionHandoffDefaults,
    parseSessionHandoffIgnoredIncludeGlobs,
    SESSION_HANDOFF_ADVANCED_WORKSPACE_SYNC_MODE_OPTIONS,
    SESSION_HANDOFF_COMMON_WORKSPACE_SYNC_MODE_OPTIONS,
    SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS,
    SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS,
    type SessionHandoffWorkspaceMode,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { resolveSessionHandoffPickerSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffPickerSourceMachineId';
import { useSessionHandoffExistingStateAvailability } from '@/sync/domains/sessionHandoff/useSessionHandoffExistingStateAvailability';
import {
    selectWorkspaceSyncRelationshipSummariesForHandoff,
    selectWorkspaceSyncLinkedHandoffChoice,
    type WorkspaceSyncRelationshipSummary,
} from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { resolveWorkspaceSyncModeTranslationKey } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { useWorkspaceSyncRelationshipSummaries } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { useWorkspaceSyncEngineReadiness } from '@/sync/domains/sessionHandoff/useWorkspaceSyncEngineReadiness';
import {
    resolveSessionHandoffStartBlockedTranslationKey,
    resolveSessionHandoffStartReadiness,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffStartReadiness';
import {
    useAllSessionListRenderables,
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useMachineRecordValues,
    useSession,
    useSessionListRenderable,
    useSettingMutable,
} from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { useStableRecentPathsForMachine } from '@/utils/sessions/useStableRecentPathsForMachine';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getServerProfileLegacyServerIds } from '@/sync/domains/server/serverProfiles';

import type { SessionHandoffPickerResult } from './openSessionHandoffPicker';
import { Icon } from '@/components/ui/icons/Icon';
import { WorkspaceActivationContentPolicyFields, WorkspaceActivationDestinationFields, WorkspaceActivationModeField } from '@/components/workspaces/activation/WorkspaceActivationEditor';
import { createWorkspaceSyncConflictDetailsResource } from '@/components/workspaces/sync/workspaceSyncConflictDetailsTab';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readManagedMachineSelectionName, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { SESSION_HANDOFF_SANDBOX_PRESET_REQUIRED } from '@/sync/domains/sessionHandoff/executeSessionHandoffAction';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
const SessionHandoffMachineSelectionContent = React.lazy(async () => ({
    default: (await import('./SessionHandoffMachineSelectionContent')).SessionHandoffMachineSelectionContent,
}));

export type SessionHandoffPickerModalProps = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    onResolve: (value: SessionHandoffPickerResult | null) => void;
    onRequestClose?: () => void;
    awaitingAdmission?: boolean;
    inlineErrorCode?: string | null;
}>;

const stylesheet = StyleSheet.create(() => ({
    body: {
        flex: 1,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 10,
    },
    blockedReason: {
        flex: 1,
    },
}));

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function relationshipEndpointTitle(summary: WorkspaceSyncRelationshipSummary): string {
    const separator = summary.relationship.mode === 'keep_both_in_sync' ? ' ↔ ' : ' → ';
    return `${summary.alpha.label}${separator}${summary.beta.label}`;
}

const EMPTY_PATH_SELECTION_FAVORITES = [] as const;
const ignorePathSelectionRequestClose = () => {};

export function SessionHandoffPickerModal({ onClose, setChrome, onResolve, sessionId, sourceMachineId, serverId, inlineErrorCode, awaitingAdmission = false }: SessionHandoffPickerModalProps) {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    useMachineReachabilityRevision();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const actionSpec = getActionSpec('session.handoff');

    const sessions = useAllSessionListRenderables();
    const sessionRecord = useSession(sessionId);
    const sessionRenderable = useSessionListRenderable(sessionId);
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeServerMachines = useMachineRecordValues() ?? [];
    const activeServer = useActiveServerSnapshot();
    const [favoriteMachineIds, toggleFavoriteMachineId] = useMachineFavorites('first');
    const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
    const [sessionHandoffDefaultsRaw] = useSettingMutable('sessionHandoffDefaultsV1');
    const relationshipSummaries = useWorkspaceSyncRelationshipSummaries(undefined, serverId ?? undefined);
    const sessionHandoffDefaults = React.useMemo(
        () => normalizeSessionHandoffDefaults(sessionHandoffDefaultsRaw),
        [sessionHandoffDefaultsRaw],
    );
    const [openWorkspaceSyncModeMenu, setOpenWorkspaceSyncModeMenu] = React.useState(false);
    const [openAdvancedWorkspaceModeMenu, setOpenAdvancedWorkspaceModeMenu] = React.useState(false);
    const [openDirectTargetModeMenu, setOpenDirectTargetModeMenu] = React.useState(false);

    const allServerMachines = React.useMemo(() => {
        const sid = normalizeId(serverId);
        if (!sid) return [];
        return [...(resolveServerScopedMachines({
            serverId: sid,
            serverIdAliases: getServerProfileLegacyServerIds(sid),
            activeServerId: normalizeId(activeServer.serverId),
            activeMachines: activeServerMachines,
            machineListByServerId,
            machineListStatusByServerId,
        }) ?? [])];
    }, [activeServer.serverId, activeServerMachines, machineListByServerId, machineListStatusByServerId, serverId]);
    const currentSessionMetadata = React.useMemo(() => {
        if (sessionRecord) return readSessionOwnerMetadataView(sessionRecord);
        if (readSessionMetadataLayoutVersion(sessionRenderable?.metadataLayoutVersion) !== 0) return null;
        return sessionRenderable?.metadata ?? null;
    }, [sessionRecord, sessionRenderable]);
    const resolvedSourceMachineId = React.useMemo(
        () => resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId,
            sessionMetadata: currentSessionMetadata,
        }),
        [currentSessionMetadata, sourceMachineId],
    );
    const sourceMachine = React.useMemo(() => {
        if (!resolvedSourceMachineId) return null;
        return allServerMachines.find((machine: any) => normalizeId(machine?.id) === resolvedSourceMachineId) ?? null;
    }, [allServerMachines, resolvedSourceMachineId]);
    const canAttemptSourceMachine = canAttemptMachineSpawn({
        machine: sourceMachine,
        selectedMachineId: resolvedSourceMachineId,
        scope,
    }) && sourceMachine?.availability?.kind !== 'locked'
        && (!sourceMachine?.access || sourceMachine.access.accessState === 'ready');
    const resolvedSourceRootPath = React.useMemo(
        () => resolveAbsolutePath(
            normalizeId(currentSessionMetadata?.path),
            currentSessionMetadata?.homeDir ?? sourceMachine?.metadata?.homeDir,
        ),
        [currentSessionMetadata, sourceMachine],
    );
    const workspaceSourcePathSafety = React.useMemo(() => {
        const sourceHomeDir = currentSessionMetadata?.homeDir;
        const fallbackSourceHomeDir = sourceMachine?.metadata?.homeDir;
        return evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
            sourcePath: resolvedSourceRootPath,
            sourceHomeDir,
            fallbackSourceHomeDir,
        });
    }, [currentSessionMetadata?.homeDir, resolvedSourceRootPath, sourceMachine?.metadata?.homeDir]);
    const isExternalSession = Boolean(
        readExternalSessionLink(currentSessionMetadata),
    );
    const machines = React.useMemo(() => {
        return allServerMachines.filter((machine: any) => {
            const machineId = normalizeId(machine?.id);
            if (!machineId) return false;
            if (machine?.revokedAt) return false;
            return true;
        });
    }, [allServerMachines]);
    React.useEffect(() => {
        // Machine storage is the authoritative hydration/event boundary. Its
        // subscription rerenders this picker when the first machine snapshot
        // arrives, so one credential-backed refresh is sufficient.
        if (sync.getCredentials()) {
            void sync.refreshMachinesThrottled({ force: true });
        }
    }, [serverId]);

    const favoriteMachines = React.useMemo(() => {
        const byId = new Map(machines.map((machine: any) => [machine?.id, machine] as const));
        return favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as any[];
    }, [favoriteMachineIds, machines]);

    const recentMachines = React.useMemo(() => {
        return getRecentMachinesFromSessions({ machines, sessions });
    }, [machines, sessions]);

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [managedTarget, setManagedTarget] = React.useState<ManagedMachineSelectionDraft | null>(null);
    const [machineMenuOpenRequest, requestMachineMenuOpen] = React.useReducer((count: number) => count + 1, 0);
    // The receiving Machine's refusal belongs to the machine it refused; a new choice clears it.
    const [refusalCode, setRefusalCode] = React.useState(inlineErrorCode);
    const [choiceChangedSinceRefusal, setChoiceChangedSinceRefusal] = React.useState(false);
    if (refusalCode !== inlineErrorCode) {
        setRefusalCode(inlineErrorCode);
        setChoiceChangedSinceRefusal(false);
    }
    const sandboxPresetRequired = inlineErrorCode === SESSION_HANDOFF_SANDBOX_PRESET_REQUIRED && !choiceChangedSinceRefusal;
    const [targetPath, setTargetPath] = React.useState<string | null>(null);
    const { approvalId, openApproval, requestApproval } = useActionApprovalContinuation({
        scopeKey: JSON.stringify([serverId, scope?.accountId, sessionId]),
        serverId: serverId ?? '',
        onExecuted: () => {},
    });
    React.useEffect(() => {
        if (approvalId) openApproval();
    }, [approvalId, openApproval]);
    const sourceWithoutFolder = readSessionDirectoryKind(currentSessionMetadata) === 'managed';
    const managedTargetWithoutWorkspace = sourceWithoutFolder && managedTarget !== null;
    const selectedMachine = React.useMemo(
        () => machines.find((machine: any) => normalizeId(machine?.id) === normalizeId(selectedMachineId)) ?? null,
        [machines, selectedMachineId],
    );
    const canAttemptSelectedMachine = managedTarget !== null || canAttemptMachineSpawn({ machine: selectedMachine, selectedMachineId, scope });
    const recentTargetPaths = useStableRecentPathsForMachine({
        machineId: selectedMachineId,
        recentMachinePaths,
        sessions,
        cacheScopeKey: normalizeId(serverId) || null,
    });
    const targetMachineHomeDir = String(selectedMachine?.metadata?.homeDir ?? '').trim() || '/home';
    const resolvedTargetPath = React.useMemo(
        () => resolveAbsolutePath(targetPath?.trim() ?? '', targetMachineHomeDir),
        [targetMachineHomeDir, targetPath],
    );
    const workspaceTargetPathSafety = React.useMemo(
        () => evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
            sourcePath: resolvedTargetPath,
            sourceHomeDir: targetMachineHomeDir,
        }),
        [resolvedTargetPath, targetMachineHomeDir],
    );
    const recentTargetPathOptions = React.useMemo(
        () => recentTargetPaths.map((path, index) => ({ path, lastUsedAt: index })),
        [recentTargetPaths],
    );
    const [selectedRelationshipId, setSelectedRelationshipId] = React.useState<string | null>(null);
    const [selectedLinkedWorkspace, setSelectedLinkedWorkspace] = React.useState(false);
    const handleTargetPathChange = React.useCallback((path: string) => {
        if (awaitingAdmission) return;
        setTargetPath(path.trim() || null);
        setSelectedRelationshipId(null);
        setSelectedLinkedWorkspace(false);
    }, [awaitingAdmission]);
    const isSameMachine = Boolean(resolvedSourceMachineId && selectedMachineId === resolvedSourceMachineId);
    const [transferSessionData, setTransferSessionData] = React.useState(true);
    const existingStateAvailability = useSessionHandoffExistingStateAvailability({ serverId, sourceMachineId: resolvedSourceMachineId, targetMachineId: selectedMachineId });
    const existingStateRequested = !managedTarget && !isSameMachine && !transferSessionData;
    const transferChoiceDisabled = awaitingAdmission || existingStateAvailability !== 'available';
    const transferHintKey = existingStateAvailability === 'checking'
        ? 'sessionHandoff.transferSessionData.checking'
        : 'sessionHandoff.transferSessionData.updateRequired';
    const normalizedSourcePath = normalizeLocalPathForComparison(resolvedSourceRootPath);
    const normalizedTargetPath = normalizeLocalPathForComparison(resolvedTargetPath);
    const sameMachineDestinationAllowed = Boolean(normalizedSourcePath && normalizedTargetPath && normalizedTargetPath !== normalizedSourcePath);
    const [workspaceSyncModeOverride, setWorkspaceSyncMode] = React.useState<SessionHandoffWorkspaceMode | null>(null);
    const workspaceSyncMode = managedTargetWithoutWorkspace ? 'none' : workspaceSyncModeOverride
        ?? (isSameMachine ? 'none' : managedTarget ? 'copy_once' : sessionHandoffDefaults.workspaceSyncMode);
    const [advancedExpanded, setAdvancedExpanded] = React.useState(
        sessionHandoffDefaults.workspaceSyncMode === 'mirror_exactly' || sessionHandoffDefaults.workspaceSyncMode === 'keep_both_in_sync',
    );
    const [contentSelection, setContentSelection] = React.useState<'git_worktree' | 'all_files'>('git_worktree');
    const [includeIgnoredMode, setIncludeIgnoredMode] = React.useState<'exclude' | 'include_selected'>(sessionHandoffDefaults.includeIgnoredMode);
    const [ignoredIncludeGlobsDraft, setIgnoredIncludeGlobsDraft] = React.useState(
        () => sessionHandoffDefaults.ignoredIncludeGlobs.join(', '),
    );
    const ignoredIncludeGlobs = React.useMemo(
        () => parseSessionHandoffIgnoredIncludeGlobs(ignoredIncludeGlobsDraft),
        [ignoredIncludeGlobsDraft],
    );
    const [directTargetMode, setDirectTargetMode] = React.useState<'keep_direct' | 'convert_to_persisted'>(sessionHandoffDefaults.directTargetMode);
    const matchingRelationshipSummaries = React.useMemo(
        () => selectWorkspaceSyncRelationshipSummariesForHandoff(relationshipSummaries, {
            source: {
                serverId: normalizeId(serverId),
                machineId: resolvedSourceMachineId ?? '',
                rootPath: resolvedSourceRootPath,
            },
            target: {
                serverId: normalizeId(serverId),
                machineId: normalizeId(selectedMachineId),
                rootPath: resolvedTargetPath,
            },
        }),
        [relationshipSummaries, resolvedSourceMachineId, resolvedSourceRootPath, resolvedTargetPath, selectedMachineId, serverId],
    );
    const linkedWorkspaceChoice = React.useMemo(
        () => selectWorkspaceSyncLinkedHandoffChoice(relationshipSummaries, {
            source: {
                serverId: normalizeId(serverId),
                machineId: resolvedSourceMachineId ?? '',
                rootPath: resolvedSourceRootPath,
            },
            target: {
                serverId: normalizeId(serverId),
                machineId: normalizeId(selectedMachineId),
                rootPath: resolvedTargetPath,
            },
        }),
        [relationshipSummaries, resolvedSourceMachineId, resolvedSourceRootPath, resolvedTargetPath, selectedMachineId, serverId],
    );
    const selectedRelationshipSummary = React.useMemo(
        () => matchingRelationshipSummaries.find((summary) => summary.relationshipId === selectedRelationshipId) ?? null,
        [matchingRelationshipSummaries, selectedRelationshipId],
    );
    React.useEffect(() => {
        if (selectedRelationshipId && !selectedRelationshipSummary) {
            setSelectedRelationshipId(null);
        }
    }, [selectedRelationshipId, selectedRelationshipSummary]);
    React.useEffect(() => {
        if (selectedLinkedWorkspace && !linkedWorkspaceChoice) setSelectedLinkedWorkspace(false);
    }, [linkedWorkspaceChoice, selectedLinkedWorkspace]);
    const relationshipChoiceItems = React.useMemo(
        () => matchingRelationshipSummaries.map((summary, index) => ({
            id: `existing-relationship-${index}`,
            relationshipId: summary.relationshipId,
            title: relationshipEndpointTitle(summary),
            subtitle: t(resolveWorkspaceSyncModeTranslationKey(summary.relationship.mode) ?? 'workspaceSync.mode.keepSynced'),
        })),
        [matchingRelationshipSummaries],
    );
    const selectedRelationshipChoice = React.useMemo(
        () => relationshipChoiceItems.find((item) => item.relationshipId === selectedRelationshipId) ?? null,
        [relationshipChoiceItems, selectedRelationshipId],
    );
    const selectedWorkspaceSyncMode = React.useMemo(
        () => SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS.find((option) => option.id === workspaceSyncMode)
            ?? SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS[0],
        [workspaceSyncMode],
    );
    const workspacePolicyControlsDisabled = existingStateRequested || workspaceSyncMode === 'none';

    const handleCancel = React.useCallback(() => {
        onResolve(null);
        onClose();
    }, [onClose, onResolve]);

    const parsedWorkspaceAction = React.useMemo(() => {
        if (existingStateRequested) return HandoffWorkspaceActionV1Schema.parse({ kind: 'none' });
        if (selectedLinkedWorkspace && linkedWorkspaceChoice) return HandoffWorkspaceActionV1Schema.parse({ kind: 'linked_workspace' });
        const candidate = buildSessionHandoffWorkspaceAction({
            workspaceSyncRelationshipId: selectedRelationshipSummary?.relationshipId,
            workspaceSyncMode,
            contentSelection,
            includeIgnoredMode,
            ignoredIncludeGlobs,
        });
        if (!candidate) return null;
        const parsed = HandoffWorkspaceActionV1Schema.safeParse(candidate);
        return parsed.success ? parsed.data : null;
    }, [contentSelection, existingStateRequested, ignoredIncludeGlobs, includeIgnoredMode, linkedWorkspaceChoice, selectedLinkedWorkspace, selectedRelationshipSummary?.relationshipId, workspaceSyncMode]);

    const workspaceEngineRequired = !existingStateRequested && Boolean(selectedRelationshipSummary || selectedLinkedWorkspace || workspaceSyncMode !== 'none');
    const sourceEngineReadiness = useWorkspaceSyncEngineReadiness(
        workspaceEngineRequired && resolvedSourceMachineId
            ? { serverId, machineId: resolvedSourceMachineId }
            : null,
    );
    const targetEngineReadiness = useWorkspaceSyncEngineReadiness(
        workspaceEngineRequired && selectedMachineId
            ? { serverId, machineId: selectedMachineId }
            : null,
    );
    const startReadiness = resolveSessionHandoffStartReadiness({
        targetMachineSelected: Boolean(selectedMachine || managedTarget),
        targetMachineAttemptable: canAttemptSelectedMachine,
        sourceMachineAttemptable: canAttemptSourceMachine,
        relationshipRequested: !existingStateRequested && Boolean(selectedRelationshipId || selectedLinkedWorkspace),
        relationshipResolved: Boolean(selectedRelationshipSummary || (selectedLinkedWorkspace && linkedWorkspaceChoice)),
        workspaceActionResolved: Boolean(parsedWorkspaceAction),
        workspaceEngineRequired,
        machineCarrierRequired: Boolean(
            resolvedSourceMachineId
            && (managedTarget || (selectedMachineId && resolvedSourceMachineId !== selectedMachineId))
        ),
        sourcePathAllowed: workspaceSourcePathSafety.allowed,
        // The target daemon allocates a no-folder session's private folder itself.
        targetPathAllowed: sourceWithoutFolder || (
            (!isSameMachine || sameMachineDestinationAllowed)
            && (!workspaceEngineRequired || workspaceTargetPathSafety.allowed)
        ),
        sourceEngineReadiness,
        targetEngineReadiness: managedTarget ? null : targetEngineReadiness,
    });
    const blockedReasonKey = resolveSessionHandoffStartBlockedTranslationKey(startReadiness);

    const handleStart = React.useCallback(() => {
        if (awaitingAdmission) return;
        if (!binding?.isCurrent()) return;
        const targetMachineId = normalizeId(selectedMachineId);
        const sourceRootPath = normalizeId(currentSessionMetadata?.path);
        if (!startReadiness.canStart) return;
        if (!targetMachineId && !managedTarget) return;
        if (!canAttemptSelectedMachine) return;
        if (existingStateRequested && existingStateAvailability !== 'available') return;
        if (!existingStateRequested && selectedRelationshipId && !selectedRelationshipSummary) return;
        if (!existingStateRequested && selectedLinkedWorkspace && !linkedWorkspaceChoice) return;
        if (workspaceEngineRequired && !workspaceSourcePathSafety.allowed) return;
        if (workspaceEngineRequired && !sourceWithoutFolder && !workspaceTargetPathSafety.allowed) return;
        if (!parsedWorkspaceAction) return;
        const reviewSummary = existingStateRequested ? null : selectedRelationshipSummary ?? (selectedLinkedWorkspace && linkedWorkspaceChoice
            ? relationshipSummaries.find((summary) => linkedWorkspaceChoice.relationshipIds.includes(summary.relationshipId))
            : null);
        onResolve({
            ...(managedTarget ? { managedTarget: {
                draft: managedTarget,
                lifetime: readServerAccountScopeOwnerLifetime(binding),
                onApprovalPending: requestApproval,
            } } : { targetMachineId }),
            stateTransfer: existingStateRequested ? 'existing' : 'transfer',
            targetMachineLabel: managedTarget
                ? readManagedMachineSelectionName(managedTarget)
                : normalizeId(selectedMachine?.metadata?.displayName) || targetMachineId,
            // A no-folder session gets its own private folder on the target; no path is chosen here.
            ...(resolvedTargetPath && !sourceWithoutFolder ? { targetPath: resolvedTargetPath } : {}),
            ...(sourceRootPath ? { sourceRootPath } : {}),
            targetSessionStorageMode: isExternalSession
                ? (directTargetMode === 'convert_to_persisted' ? 'persisted' : 'direct')
                : 'persisted',
            workspaceAction: parsedWorkspaceAction,
            ...(reviewSummary ? { workspaceSyncReviewResource: createWorkspaceSyncConflictDetailsResource(
                reviewSummary,
                selectedLinkedWorkspace && linkedWorkspaceChoice ? linkedWorkspaceChoice.sourceWorkspaceRefId : undefined,
            ) } : {}),
            ...(reviewSummary ? { workspaceSyncReviewRelationshipIds: selectedLinkedWorkspace && linkedWorkspaceChoice
                ? linkedWorkspaceChoice.relationshipIds : [reviewSummary.relationshipId] } : {}),
        });
    }, [awaitingAdmission, binding, canAttemptSelectedMachine, currentSessionMetadata?.path, directTargetMode, existingStateAvailability, existingStateRequested, sourceWithoutFolder, isExternalSession, linkedWorkspaceChoice, managedTarget, onResolve, parsedWorkspaceAction, relationshipSummaries, requestApproval, resolvedTargetPath, selectedLinkedWorkspace, selectedMachine?.metadata?.displayName, selectedMachineId, selectedRelationshipId, selectedRelationshipSummary, startReadiness.canStart, workspaceEngineRequired, workspaceSourcePathSafety.allowed, workspaceTargetPathSafety.allowed]);

    const selectMachine = (machineId: string) => {
        if (awaitingAdmission) return;
        setChoiceChangedSinceRefusal(true);
        setManagedTarget(null);
        setTransferSessionData(true);
        setSelectedMachineId(normalizeId(machineId) || null);
        handleTargetPathChange('');
    };
    const toggleFavorite = (machine: NonNullable<typeof selectedMachine>) => {
        if (awaitingAdmission) return;
        toggleFavoriteMachineId(machine.id);
    };

    const canStart = startReadiness.canStart && (!existingStateRequested || existingStateAvailability === 'available');

    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            {awaitingAdmission ? (
                <Text testID="session-handoff-awaiting-admission" style={styles.blockedReason} accessibilityLiveRegion="polite">
                    {t('sessionHandoff.awaitingAdmission')}
                </Text>
            ) : blockedReasonKey ? (
                <Text
                    testID="session-handoff-start-blocked-reason"
                    style={styles.blockedReason}
                    accessibilityLiveRegion="polite"
                >
                    {t(blockedReasonKey)}
                </Text>
            ) : null}
            <RoundButton display="inverted" title={t(awaitingAdmission ? 'common.close' : 'common.cancel')} onPress={handleCancel} />
            <RoundButton
                testID="session-handoff-start"
                title={actionSpec.title}
                onPress={handleStart}
                disabled={!canStart || awaitingAdmission}
                accessibilityHint={awaitingAdmission ? t('sessionHandoff.awaitingAdmission') : blockedReasonKey ? t(blockedReasonKey) : undefined}
            />
        </View>
    ), [actionSpec.title, awaitingAdmission, blockedReasonKey, canStart, handleCancel, handleStart, styles.blockedReason, styles.footer]);

    // Which session, and where it runs now (lab scene 4); the Action's own description stays for agents.
    const sessionName = sessionRecord ? getSessionName(sessionRecord, serverId) : sessionRenderable ? getSessionName(sessionRenderable, serverId) : null;
    const sourceMachineName = sourceMachine ? getMachineSentenceName(sourceMachine) : currentSessionMetadata?.host ?? null;
    const subtitle = sessionName && sourceMachineName
        ? t('sessionHandoff.sheetSubtitle', { session: sessionName, machine: sourceMachineName })
        : actionSpec.description;
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: actionSpec.title,
        subtitle,
        testID: 'session-handoff-modal',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92 },
        phonePresentation: 'sheet' as const,
        footer,
    }), [actionSpec.title, footer, subtitle]);

    useModalCardChrome(setChrome, chrome);

    return (
            <View style={styles.body}>
                <ItemList presentation="grouped" keyboardAware style={{ paddingTop: 0 }} pointerEvents={awaitingAdmission ? 'none' : 'auto'} importantForAccessibility={awaitingAdmission ? 'no-hide-descendants' : 'auto'}>
                    {!canAttemptSourceMachine ? (
                        <SurfaceStateCard
                            testID="session-handoff-retained-history"
                            kind="warning"
                            size="line"
                            title={t('machineRequester.handoffUnavailable')}
                            reason={t('machineRequester.resumeElsewhere', { machine: sourceMachine ? getMachineSentenceName(sourceMachine) : currentSessionMetadata?.host ?? t('status.unknown') })}
                        />
                    ) : null}
                    <WorkspaceActivationDestinationFields
                        disabled={awaitingAdmission}
                        machineNotice={sandboxPresetRequired ? (
                            <SurfaceStateCard
                                testID="session-handoff-sandbox-preset-required"
                                kind="warning"
                                size="line"
                                title={t('sessionHandoff.failure.targetRequiresSandboxPreset')}
                                action={{ testID: 'session-handoff-sandbox-preset-required:choose', label: t('sessionHandoff.failure.chooseSandboxPreset'), onPress: requestMachineMenuOpen }}
                            />
                        ) : null}
                        machine={{
                            machines: machines as any, selectedMachine: selectedMachine as any, serverId: serverId ?? undefined,
                            recentMachines: recentMachines as any, favoriteMachines: favoriteMachines as any,
                            showFavorites: favoriteMachines.length > 0, showRecent: recentMachines.length > 0,
                            showSearch: true, presentation: 'dropdown', showCliGlyphs: false,
                            autoDetectCliGlyphs: false, disableOfflineMachines: true,
                            testIdPrefix: 'session-handoff-machine',
                            dropdownTestID: 'session-handoff-machine-dropdown-trigger',
                            dropdownOpenRequest: machineMenuOpenRequest,
                            onSelect: machine => selectMachine(machine.id),
                            onToggleFavorite: toggleFavorite,
                            dropdownSubtitle: managedTarget ? (() => {
                                const name = readManagedMachineSelectionName(managedTarget);
                                return name ? t('sessionHandoff.managedTarget.selected', { name }) : t('managedMachines.picker.newMachine');
                            })()
                                : selectedMachine ? getMachineSentenceName(selectedMachine) : undefined,
                            renderDropdownContent: serverId ? ({ maxHeight, requestClose }) => <React.Suspense fallback={null}><SessionHandoffMachineSelectionContent
                                serverId={serverId}
                                machines={machines}
                                selectedMachine={selectedMachine}
                                recentMachines={recentMachines}
                                favoriteMachines={favoriteMachines}
                                selectedManagedMachine={managedTarget}
                                onSelectMachine={selectMachine}
                                onSelectManagedMachine={(draft) => {
                                    if (awaitingAdmission || !binding?.isCurrent()) return;
                                    setChoiceChangedSinceRefusal(true);
                                    setSelectedMachineId(null);
                                    setManagedTarget(draft);
                                    setTransferSessionData(true);
                                    handleTargetPathChange(resolvedSourceRootPath);
                                }}
                                onToggleFavorite={toggleFavorite}
                                maxHeight={maxHeight}
                                requestClose={() => requestClose('selection')}
                            /></React.Suspense> : undefined,
                        }}
                        path={{
                            machineHomeDir: targetMachineHomeDir, initialValue: targetPath ?? '',
                            initialSuggestionMode: 'history', favorites: EMPTY_PATH_SELECTION_FAVORITES,
                            recents: recentTargetPathOptions, machineId: selectedMachineId,
                            serverId: normalizeId(serverId) || null,
                            machinePlatform: machineMetadataPlatformToTarget(selectedMachine?.metadata?.platform),
                            onCommit: handleTargetPathChange, onChangeDraftPath: handleTargetPathChange,
                            onRequestClose: ignorePathSelectionRequestClose,
                        }}
                        pathTitle={t('machine.launchNewSessionInDirectory')}
                        fixedFolderLabel={sourceWithoutFolder
                            ? t('session.folderless.privateFolderOn', {
                                machine: selectedMachine ? getMachineSentenceName(selectedMachine)
                                    : readManagedMachineSelectionName(managedTarget) ?? normalizeId(selectedMachineId),
                            })
                            : null}
                    />
                    {managedTarget ? <ItemGroup>
                        <Item
                            testID="session-handoff-transfer-session-data-new-machine"
                            title={t('sessionHandoff.transferSessionData.title')}
                            subtitle={t('sessionHandoff.transferSessionData.alwaysOnForNewMachine')}
                            subtitleLines={0}
                            // A fact, not an unavailable choice: an info row at full ink whose locked switch only draws.
                            mode="info"
                            rightElement={<Switch value disabled accessibilityLabel={t('sessionHandoff.transferSessionData.title')}
                                accessibilityHint={t('sessionHandoff.transferSessionData.alwaysOnForNewMachine')} />}
                        />
                    </ItemGroup> : null}
                    {!isSameMachine && !managedTarget ? <ItemGroup>
                        <Item
                            title={t('sessionHandoff.transferSessionData.title')}
                            subtitle={t(existingStateAvailability === 'available' ? 'sessionHandoff.transferSessionData.subtitle' : transferHintKey)}
                            rightElement={<Switch testID="session-handoff-transfer-session-data" value={transferSessionData}
                                disabled={transferChoiceDisabled}
                                accessibilityLabel={t('sessionHandoff.transferSessionData.title')}
                                accessibilityHint={transferChoiceDisabled ? t(transferHintKey) : t('sessionHandoff.transferSessionData.subtitle')}
                                onValueChange={(value) => { if (!transferChoiceDisabled) setTransferSessionData(value); }} />}
                            disabled={transferChoiceDisabled}
                            onPress={() => { if (!transferChoiceDisabled) setTransferSessionData(!transferSessionData); }}
                            showChevron={false}
                        />
                        {inlineErrorCode === 'existing_session_state_unavailable' ? <Text testID="session-handoff-session-data-error" accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: theme.colors.text.destructive }}>{t('sessionHandoff.transferSessionData.sessionMissing')}</Text> : null}
                    </ItemGroup> : null}
                    {!managedTargetWithoutWorkspace ? <ItemGroup
                        title={t('settingsSession.handoff.groupTitle')}
                    >
                        <WorkspaceActivationModeField
                            open={openWorkspaceSyncModeMenu}
                            onOpenChange={setOpenWorkspaceSyncModeMenu}
                            selectedId={existingStateRequested ? 'none' : selectedLinkedWorkspace && linkedWorkspaceChoice ? 'linked_workspace' : selectedRelationshipChoice?.id ?? workspaceSyncMode}
                            title={existingStateRequested ? t('settingsSession.handoff.workspaceMode.title') : selectedLinkedWorkspace && linkedWorkspaceChoice
                                    ? t('settingsSession.handoff.workspaceMode.linkedTitle', { hub: linkedWorkspaceChoice.hubMachineName })
                                    : selectedRelationshipChoice?.title ?? t('settingsSession.handoff.workspaceMode.title')}
                            subtitle={existingStateRequested ? t('sessionHandoff.transferSessionData.workspaceRequiresTransfer') : selectedLinkedWorkspace && linkedWorkspaceChoice
                                    ? linkedWorkspaceChoice.routeLabel
                                    : selectedRelationshipChoice?.subtitle ?? t(selectedWorkspaceSyncMode.subtitleKey)}
                            icon={<Icon name="folder" size={16} color={theme.colors.text.secondary} />}
                            testID="session-handoff-workspace-sync-mode-trigger"
                            disabled={awaitingAdmission || existingStateRequested}
                            items={[
                                ...SESSION_HANDOFF_COMMON_WORKSPACE_SYNC_MODE_OPTIONS.map((item) => ({
                                    id: item.id,
                                    title: t(item.titleKey),
                                    subtitle: t(item.subtitleKey),
                                })),
                                ...relationshipChoiceItems.map(({ id, title, subtitle }) => ({ id, title, subtitle })),
                                ...(linkedWorkspaceChoice ? [{
                                    id: 'linked_workspace',
                                    title: t('settingsSession.handoff.workspaceMode.linkedTitle', { hub: linkedWorkspaceChoice.hubMachineName }),
                                    subtitle: linkedWorkspaceChoice.routeLabel,
                                }] : []),
                            ]}
                            onSelect={(itemId) => {
                                if (awaitingAdmission || existingStateRequested) return;
                                const relationshipChoice = relationshipChoiceItems.find((item) => item.id === itemId);
                                if (relationshipChoice) {
                                    setSelectedRelationshipId(relationshipChoice.relationshipId);
                                    setSelectedLinkedWorkspace(false);
                                    setOpenWorkspaceSyncModeMenu(false);
                                    return;
                                }
                                if (itemId === 'linked_workspace' && linkedWorkspaceChoice) {
                                    setSelectedRelationshipId(null);
                                    setSelectedLinkedWorkspace(true);
                                    setOpenWorkspaceSyncModeMenu(false);
                                    return;
                                }
                                setSelectedRelationshipId(null);
                                setSelectedLinkedWorkspace(false);
                                setWorkspaceSyncMode(itemId as SessionHandoffWorkspaceMode);
                                setOpenWorkspaceSyncModeMenu(false);
                            }}
                        />
                        {!selectedRelationshipSummary && !selectedLinkedWorkspace ? <ExpandableItem
                            testID="session-handoff-advanced"
                            expanded={advancedExpanded}
                            onExpandedChange={(expanded) => { if (!awaitingAdmission) setAdvancedExpanded(expanded); }}
                            header={(state) => (
                                <Item
                                    {...state.headerProps}
                                    title={t('settingsSession.handoff.advanced.title')}
                                    subtitle={t('settingsSession.handoff.advanced.subtitle')}
                                    icon={<Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} />}
                                />
                            )}
                        >
                            <ItemGroup>
                                <WorkspaceActivationModeField
                                    open={openAdvancedWorkspaceModeMenu}
                                    onOpenChange={setOpenAdvancedWorkspaceModeMenu}
                                    selectedId={existingStateRequested ? 'none' : workspaceSyncMode}
                                    title={t('settingsSession.handoff.advanced.modeTitle')}
                                    subtitle={t(existingStateRequested ? 'sessionHandoff.transferSessionData.workspaceRequiresTransfer' : selectedWorkspaceSyncMode.subtitleKey)}
                                    icon={<Icon name="warning" size={16} color={theme.colors.text.secondary} />}
                                    testID="session-handoff-advanced-workspace-mode-trigger"
                                    disabled={awaitingAdmission || existingStateRequested}
                                    items={SESSION_HANDOFF_ADVANCED_WORKSPACE_SYNC_MODE_OPTIONS.map((item) => ({
                                        id: item.id,
                                        title: t(item.titleKey),
                                        subtitle: t(item.subtitleKey),
                                    }))}
                                    onSelect={(itemId) => {
                                        if (awaitingAdmission || existingStateRequested) return;
                                        setSelectedRelationshipId(null);
                                        setWorkspaceSyncMode(itemId as SessionHandoffWorkspaceMode);
                                        setOpenAdvancedWorkspaceModeMenu(false);
                                    }}
                                />
                                <WorkspaceActivationContentPolicyFields
                                    contentSelection={contentSelection}
                                    onContentSelectionChange={setContentSelection}
                                    includeIgnoredMode={includeIgnoredMode}
                                    onIncludeIgnoredModeChange={setIncludeIgnoredMode}
                                    patternsDraft={ignoredIncludeGlobsDraft}
                                    onPatternsDraftChange={setIgnoredIncludeGlobsDraft}
                                    disabled={workspacePolicyControlsDisabled || awaitingAdmission}
                                    testIdPrefix="session-handoff"
                                />
                            </ItemGroup>
                        </ExpandableItem> : null}
                    </ItemGroup> : null}
                    {managedTarget ? (
                        <NoticeLine
                            testID="session-handoff-managed-creates-first"
                            iconName="info"
                            iconColor={theme.colors.text.secondary}
                            title={t('sessionHandoff.managedTarget.createsFirst')}
                            wrap
                        />
                    ) : null}
                    {isExternalSession ? (
                        <ItemGroup
                            title={t('settingsSession.handoff.directTargetMode.groupTitle')}
                            description={t('settingsSession.handoff.directTargetMode.groupFooter')}
                        >
                            <DropdownMenu
                                open={openDirectTargetModeMenu}
                                onOpenChange={setOpenDirectTargetModeMenu}
                                variant="selectable"
                                search={false}
                                selectedId={directTargetMode}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                itemTrigger={{
                                    title: t('settingsSession.handoff.directTargetMode.title'),
                                    subtitle: t('settingsSession.handoff.directTargetMode.subtitle'),
                                    icon: <Icon name="arrows-left-right" size={16} color={theme.colors.text.secondary} />,
                                    itemProps: { disabled: awaitingAdmission },
                                }}
                                items={SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS.map((item) => ({
                                    id: item.id,
                                    title: t(item.titleKey),
                                    subtitle: t(item.subtitleKey),
                                }))}
                                onSelect={(itemId) => {
                                    if (awaitingAdmission) return;
                                    setDirectTargetMode(itemId as 'keep_direct' | 'convert_to_persisted');
                                    setOpenDirectTargetModeMenu(false);
                                }}
                            />
                        </ItemGroup>
                    ) : null}
                </ItemList>
            </View>
    );
}
