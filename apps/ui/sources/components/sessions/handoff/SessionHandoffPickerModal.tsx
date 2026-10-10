import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
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

export function SessionHandoffPickerModal({ onClose, setChrome, onResolve, sessionId, sourceMachineId, serverId, awaitingAdmission = false }: SessionHandoffPickerModalProps) {
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
    const [favoriteMachinesRaw, setFavoriteMachinesRaw] = useSettingMutable('favoriteMachines');
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

    const favoriteMachineIds = Array.isArray(favoriteMachinesRaw) ? favoriteMachinesRaw : [];
    const favoriteMachines = React.useMemo(() => {
        const byId = new Map(machines.map((machine: any) => [machine?.id, machine] as const));
        return favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as any[];
    }, [favoriteMachineIds, machines]);

    const recentMachines = React.useMemo(() => {
        return getRecentMachinesFromSessions({ machines, sessions });
    }, [machines, sessions]);

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [targetPath, setTargetPath] = React.useState<string | null>(null);
    const sourceWithoutFolder = readSessionDirectoryKind(currentSessionMetadata) === 'managed';
    const selectedMachine = React.useMemo(
        () => machines.find((machine: any) => normalizeId(machine?.id) === normalizeId(selectedMachineId)) ?? null,
        [machines, selectedMachineId],
    );
    const canAttemptSelectedMachine = React.useMemo(
        () => canAttemptMachineSpawn({ machine: selectedMachine as any, selectedMachineId }),
        [selectedMachine, selectedMachineId],
    );
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
    const normalizedSourcePath = normalizeLocalPathForComparison(resolvedSourceRootPath);
    const normalizedTargetPath = normalizeLocalPathForComparison(resolvedTargetPath);
    const sameMachineDestinationAllowed = Boolean(normalizedSourcePath && normalizedTargetPath && normalizedTargetPath !== normalizedSourcePath);
    const [workspaceSyncModeOverride, setWorkspaceSyncMode] = React.useState<SessionHandoffWorkspaceMode | null>(null);
    const workspaceSyncMode = workspaceSyncModeOverride
        ?? (isSameMachine ? 'none' : sessionHandoffDefaults.workspaceSyncMode);
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
    const workspacePolicyControlsDisabled = workspaceSyncMode === 'none';

    const handleCancel = React.useCallback(() => {
        onResolve(null);
        onClose();
    }, [onClose, onResolve]);

    const parsedWorkspaceAction = React.useMemo(() => {
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
    }, [contentSelection, ignoredIncludeGlobs, includeIgnoredMode, linkedWorkspaceChoice, selectedLinkedWorkspace, selectedRelationshipSummary?.relationshipId, workspaceSyncMode]);

    const workspaceEngineRequired = Boolean(selectedRelationshipSummary || selectedLinkedWorkspace || workspaceSyncMode !== 'none');
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
        targetMachineSelected: Boolean(selectedMachine),
        targetMachineAttemptable: canAttemptSelectedMachine,
        sourceMachineAttemptable: canAttemptSourceMachine,
        relationshipRequested: Boolean(selectedRelationshipId || selectedLinkedWorkspace),
        relationshipResolved: Boolean(selectedRelationshipSummary || (selectedLinkedWorkspace && linkedWorkspaceChoice)),
        workspaceActionResolved: Boolean(parsedWorkspaceAction),
        workspaceEngineRequired,
        machineCarrierRequired: Boolean(
            resolvedSourceMachineId
            && selectedMachineId
            && resolvedSourceMachineId !== selectedMachineId
        ),
        sourcePathAllowed: workspaceSourcePathSafety.allowed,
        // The target daemon allocates a no-folder session's private folder itself.
        targetPathAllowed: sourceWithoutFolder || (
            (!isSameMachine || sameMachineDestinationAllowed)
            && (!workspaceEngineRequired || workspaceTargetPathSafety.allowed)
        ),
        sourceEngineReadiness,
        targetEngineReadiness,
    });
    const blockedReasonKey = resolveSessionHandoffStartBlockedTranslationKey(startReadiness);

    const handleStart = React.useCallback(() => {
        if (awaitingAdmission) return;
        const targetMachineId = normalizeId(selectedMachineId);
        const sourceRootPath = normalizeId(currentSessionMetadata?.path);
        if (!startReadiness.canStart) return;
        if (!targetMachineId) return;
        if (!canAttemptSelectedMachine) return;
        if (selectedRelationshipId && !selectedRelationshipSummary) return;
        if (selectedLinkedWorkspace && !linkedWorkspaceChoice) return;
        if ((selectedRelationshipSummary || selectedLinkedWorkspace || workspaceSyncMode !== 'none') && !workspaceSourcePathSafety.allowed) return;
        if ((selectedRelationshipSummary || selectedLinkedWorkspace || workspaceSyncMode !== 'none') && !sourceWithoutFolder && !workspaceTargetPathSafety.allowed) return;
        if (!parsedWorkspaceAction) return;
        const reviewSummary = selectedRelationshipSummary ?? (selectedLinkedWorkspace && linkedWorkspaceChoice
            ? relationshipSummaries.find((summary) => linkedWorkspaceChoice.relationshipIds.includes(summary.relationshipId))
            : null);
        onResolve({
            targetMachineId,
            targetMachineLabel: normalizeId(selectedMachine?.metadata?.displayName) || targetMachineId,
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
    }, [awaitingAdmission, canAttemptSelectedMachine, currentSessionMetadata?.path, directTargetMode, sourceWithoutFolder, isExternalSession, linkedWorkspaceChoice, onResolve, parsedWorkspaceAction, relationshipSummaries, resolvedTargetPath, selectedLinkedWorkspace, selectedMachine?.metadata?.displayName, selectedMachineId, selectedRelationshipId, selectedRelationshipSummary, startReadiness.canStart, workspaceSourcePathSafety.allowed, workspaceSyncMode, workspaceTargetPathSafety.allowed]);

    const canStart = startReadiness.canStart;

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

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: actionSpec.title,
        subtitle: actionSpec.description,
        testID: 'session-handoff-modal',
        dimensions: { width: 520, maxHeightRatio: 0.92 },
        footer,
    }), [actionSpec.description, actionSpec.title, footer]);

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
                            description={t('machineRequester.resumeElsewhere', { machine: getMachineDisplayName(sourceMachine) ?? currentSessionMetadata?.host ?? t('status.unknown') })}
                        />
                    ) : null}
                    <WorkspaceActivationDestinationFields
                        disabled={awaitingAdmission}
                        machine={{
                            machines: machines as any, selectedMachine: selectedMachine as any,
                            recentMachines: recentMachines as any, favoriteMachines: favoriteMachines as any,
                            showFavorites: favoriteMachines.length > 0, showRecent: recentMachines.length > 0,
                            showSearch: true, presentation: 'dropdown', showCliGlyphs: false,
                            autoDetectCliGlyphs: false, disableOfflineMachines: true,
                            testIdPrefix: 'session-handoff-machine',
                            dropdownTestID: 'session-handoff-machine-dropdown-trigger',
                            onSelect: (machine) => {
                                if (awaitingAdmission) return;
                                setSelectedMachineId(normalizeId(machine?.id) || null);
                                setTargetPath(null);
                                setSelectedRelationshipId(null);
                                setSelectedLinkedWorkspace(false);
                            },
                            onToggleFavorite: (machine) => {
                                if (awaitingAdmission) return;
                                const machineId = normalizeId(machine?.id);
                                if (!machineId) return;
                                const exists = favoriteMachineIds.includes(machineId);
                                setFavoriteMachinesRaw(exists ? favoriteMachineIds.filter((id: string) => id !== machineId) : [machineId, ...favoriteMachineIds]);
                            },
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
                                machine: getMachineDisplayName(selectedMachine) ?? normalizeId(selectedMachineId),
                            })
                            : null}
                    />
                    <ItemGroup
                        title={t('settingsSession.handoff.groupTitle')}
                        description={t('settingsSession.handoff.groupFooter')}
                    >
                        <WorkspaceActivationModeField
                            open={openWorkspaceSyncModeMenu}
                            onOpenChange={setOpenWorkspaceSyncModeMenu}
                            selectedId={selectedLinkedWorkspace && linkedWorkspaceChoice ? 'linked_workspace' : selectedRelationshipChoice?.id ?? workspaceSyncMode}
                            title={selectedLinkedWorkspace && linkedWorkspaceChoice
                                    ? t('settingsSession.handoff.workspaceMode.linkedTitle', { hub: linkedWorkspaceChoice.hubMachineName })
                                    : selectedRelationshipChoice?.title ?? t('settingsSession.handoff.workspaceMode.title')}
                            subtitle={selectedLinkedWorkspace && linkedWorkspaceChoice
                                    ? linkedWorkspaceChoice.routeLabel
                                    : selectedRelationshipChoice?.subtitle ?? t(selectedWorkspaceSyncMode.subtitleKey)}
                            icon={<Icon name="folder" size={16} color={theme.colors.text.secondary} />}
                            testID="session-handoff-workspace-sync-mode-trigger"
                            disabled={awaitingAdmission}
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
                                    rightElement={<Icon name={state.expanded ? 'caret-down' : 'caret-right'} size={16} color={theme.colors.text.secondary} />}
                                    showChevron={false}
                                />
                            )}
                        >
                            <ItemGroup>
                                <WorkspaceActivationModeField
                                    open={openAdvancedWorkspaceModeMenu}
                                    onOpenChange={setOpenAdvancedWorkspaceModeMenu}
                                    selectedId={workspaceSyncMode}
                                    title={t('settingsSession.handoff.advanced.modeTitle')}
                                    subtitle={t(selectedWorkspaceSyncMode.subtitleKey)}
                                    icon={<Icon name="warning" size={16} color={theme.colors.text.secondary} />}
                                    testID="session-handoff-advanced-workspace-mode-trigger"
                                    disabled={awaitingAdmission}
                                    items={SESSION_HANDOFF_ADVANCED_WORKSPACE_SYNC_MODE_OPTIONS.map((item) => ({
                                        id: item.id,
                                        title: t(item.titleKey),
                                        subtitle: t(item.subtitleKey),
                                    }))}
                                    onSelect={(itemId) => {
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
                    </ItemGroup>
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
