import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { evaluateSessionHandoffWorkspaceTransferSourcePathSafety, getActionSpec } from '@happier-dev/protocol';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import {
    buildSessionHandoffWorkspaceTransfer,
    normalizeSessionHandoffDefaults,
    parseSessionHandoffIgnoredIncludeGlobs,
    SESSION_HANDOFF_CONFLICT_POLICY_OPTIONS,
    SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS,
    SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS,
    SESSION_HANDOFF_WORKSPACE_TRANSFER_STRATEGY_OPTIONS,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { useMachineListByServerId, useMachineRecordValues, useSession, useSessions, useSettingMutable } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import type { SessionHandoffPickerResult } from './openSessionHandoffPicker';

type Props = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    onResolve: (value: SessionHandoffPickerResult | null) => void;
    onRequestClose?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 520,
        maxWidth: '94%',
        maxHeight: '92%',
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    body: {
        flex: 1,
    },
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 10,
    },
    bodyHeader: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 6,
    },
}));

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function mergeMachinesById(machineGroups: readonly (readonly any[] | null | undefined)[]): any[] {
    const merged = new Map<string, any>();
    for (const group of machineGroups) {
        if (!Array.isArray(group)) continue;
        for (const machine of group) {
            const machineId = normalizeId(machine?.id);
            if (!machineId) continue;
            if (!merged.has(machineId)) {
                merged.set(machineId, machine);
                continue;
            }
            merged.set(machineId, {
                ...merged.get(machineId),
                ...machine,
            });
        }
    }
    return Array.from(merged.values());
}

function expandHomeRelativePath(rawPath: unknown, homeDir: unknown): string {
    const path = String(rawPath ?? '').trim();
    if (!path) return '';
    if (!path.startsWith('~')) return path;

    const home = String(homeDir ?? '').trim();
    if (!home) return path;
    const normalizedHome = home.endsWith('/') ? home.slice(0, -1) : home;

    if (path === '~' || path === '~/') {
        return normalizedHome;
    }
    if (path.startsWith('~/')) {
        return `${normalizedHome}${path.slice(1)}`;
    }
    return path;
}

export function SessionHandoffPickerModal({ onClose, onResolve, sessionId, sourceMachineId, serverId }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const actionSpec = getActionSpec('session.handoff');

    React.useEffect(() => {
        // The picker can open before Sync has hydrated credentials (common in QA flows that inject
        // credentials into storage and then immediately navigate to the handoff UI). A one-shot
        // refresh would no-op in that window and the modal would render only the local machine.
        //
        // Retry for a short bounded window so newly-registered machines appear deterministically.
        let cancelled = false;

        const run = async () => {
            const startedAt = Date.now();
            while (!cancelled && (Date.now() - startedAt) < 10_000) {
                if (sync.getCredentials()) {
                    await sync.refreshMachinesThrottled({ force: true });
                    return;
                }
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
            }
        };

        void run();

        return () => {
            cancelled = true;
        };
    }, []);

    const sessions = useSessions() ?? [];
    const sessionRecord = useSession(sessionId);
    const machineListByServerId = useMachineListByServerId();
    const activeServerMachines = useMachineRecordValues() ?? [];
    const [favoriteMachinesRaw, setFavoriteMachinesRaw] = useSettingMutable('favoriteMachines');
    const [sessionHandoffDefaultsRaw] = useSettingMutable('sessionHandoffDefaultsV1');
    const sessionHandoffDefaults = React.useMemo(
        () => normalizeSessionHandoffDefaults(sessionHandoffDefaultsRaw),
        [sessionHandoffDefaultsRaw],
    );
    const [openConflictPolicyMenu, setOpenConflictPolicyMenu] = React.useState(false);
    const [openIgnoredModeMenu, setOpenIgnoredModeMenu] = React.useState(false);
    const [openDirectTargetModeMenu, setOpenDirectTargetModeMenu] = React.useState(false);
    const [openWorkspaceTransferStrategyMenu, setOpenWorkspaceTransferStrategyMenu] = React.useState(false);

    const allServerMachines = React.useMemo(() => {
        const sid = normalizeId(serverId);
        return mergeMachinesById([
            sid ? (machineListByServerId[sid] ?? []) : [],
            activeServerMachines,
        ]);
    }, [activeServerMachines, machineListByServerId, serverId]);
    const currentSession = React.useMemo(() => {
        if (sessionRecord) return sessionRecord;
        return sessions.find((session: any) => normalizeId(session?.id) === normalizeId(sessionId)) ?? null;
    }, [sessionId, sessionRecord, sessions]);
    const resolvedSourceMachineId = React.useMemo(
        () => normalizeId(sourceMachineId) || normalizeId((currentSession as any)?.metadata?.machineId),
        [currentSession, sourceMachineId],
    );
    const sourceMachine = React.useMemo(() => {
        if (!resolvedSourceMachineId) return null;
        return allServerMachines.find((machine: any) => normalizeId(machine?.id) === resolvedSourceMachineId) ?? null;
    }, [allServerMachines, resolvedSourceMachineId]);
    const isDirectSession = Boolean((currentSession as any)?.metadata?.directSessionV1);
    const workspaceTransferPathSafety = React.useMemo(
        () => {
            const sourceHomeDir = (currentSession as any)?.metadata?.homeDir;
            const fallbackSourceHomeDir = (sourceMachine as any)?.metadata?.homeDir;
            const sourcePath = expandHomeRelativePath(
                (currentSession as any)?.metadata?.path,
                sourceHomeDir ?? fallbackSourceHomeDir,
            );
            return evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
                sourcePath,
                sourceHomeDir,
                fallbackSourceHomeDir,
            });
        },
        [currentSession, sourceMachine],
    );

    const machines = React.useMemo(() => {
        return allServerMachines.filter((machine: any) => {
            const machineId = normalizeId(machine?.id);
            if (!machineId) return false;
            if (machine?.revokedAt) return false;
            if (resolvedSourceMachineId && machineId === resolvedSourceMachineId) return false;
            return true;
        });
    }, [allServerMachines, resolvedSourceMachineId]);

    const favoriteMachineIds = Array.isArray(favoriteMachinesRaw) ? favoriteMachinesRaw : [];
    const favoriteMachines = React.useMemo(() => {
        const byId = new Map(machines.map((machine: any) => [machine?.id, machine] as const));
        return favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as any[];
    }, [favoriteMachineIds, machines]);

    const recentMachines = React.useMemo(() => {
        const allRecent = getRecentMachinesFromSessions({ machines, sessions });
        return allRecent.filter((machine: any) => normalizeId(machine?.id) !== resolvedSourceMachineId);
    }, [machines, resolvedSourceMachineId, sessions]);

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const selectedMachine = React.useMemo(
        () => machines.find((machine: any) => normalizeId(machine?.id) === normalizeId(selectedMachineId)) ?? null,
        [machines, selectedMachineId],
    );
    const [workspaceTransferEnabled, setWorkspaceTransferEnabled] = React.useState(sessionHandoffDefaults.workspaceTransferEnabled);
    const [workspaceTransferStrategy, setWorkspaceTransferStrategy] = React.useState<'transfer_snapshot' | 'sync_changes'>(
        sessionHandoffDefaults.workspaceTransferStrategy,
    );
    const [conflictPolicy, setConflictPolicy] = React.useState<'create_sibling_copy' | 'replace_existing'>(sessionHandoffDefaults.conflictPolicy);
    const [includeIgnoredMode, setIncludeIgnoredMode] = React.useState<'exclude' | 'include_selected'>(sessionHandoffDefaults.includeIgnoredMode);
    const [ignoredIncludeGlobs, setIgnoredIncludeGlobs] = React.useState<string[]>([...sessionHandoffDefaults.ignoredIncludeGlobs]);
    const [directTargetMode, setDirectTargetMode] = React.useState<'keep_direct' | 'convert_to_persisted'>(sessionHandoffDefaults.directTargetMode);

    const effectiveWorkspaceTransferEnabled = workspaceTransferPathSafety.allowed ? workspaceTransferEnabled : false;
    const workspaceTransferControlsDisabled = !effectiveWorkspaceTransferEnabled;

    const handleCancel = React.useCallback(() => {
        onResolve(null);
        onClose();
    }, [onClose, onResolve]);

    const handleStart = React.useCallback(() => {
        const targetMachineId = normalizeId(selectedMachineId);
        if (!targetMachineId) return;
        const workspaceTransfer = buildSessionHandoffWorkspaceTransfer({
            workspaceTransferEnabled: effectiveWorkspaceTransferEnabled,
            workspaceTransferStrategy,
            conflictPolicy,
            includeIgnoredMode,
            ignoredIncludeGlobs,
        });
        onResolve({
            targetMachineId,
            targetSessionStorageMode: isDirectSession
                ? (directTargetMode === 'convert_to_persisted' ? 'persisted' : 'direct')
                : 'persisted',
            ...(workspaceTransfer ? { workspaceTransfer } : {}),
        });
    }, [conflictPolicy, directTargetMode, effectiveWorkspaceTransferEnabled, ignoredIncludeGlobs, includeIgnoredMode, isDirectSession, onResolve, selectedMachineId, workspaceTransferStrategy]);

    return (
        <View testID="session-handoff-modal" style={styles.container}>
            <View style={styles.header}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.title}>{actionSpec.title}</Text>
                    {actionSpec.description ? <Text style={styles.subtitle}>{actionSpec.description}</Text> : null}
                </View>
                <Pressable
                    onPress={handleCancel}
                    hitSlop={10}
                    style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.header.tint} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <View style={styles.bodyHeader}>
                    <Text style={styles.subtitle}>{t('newSession.selectMachineTitle')}</Text>
                </View>
                <ItemList style={{ paddingTop: 0 }}>
                    <MachineSelector
                        machines={machines as any}
                        selectedMachine={selectedMachine as any}
                        recentMachines={recentMachines as any}
                        favoriteMachines={favoriteMachines as any}
                        showFavorites={favoriteMachines.length > 0}
                        showRecent={recentMachines.length > 0}
                        showSearch={true}
                        showCliGlyphs={false}
                        autoDetectCliGlyphs={false}
                        disableOfflineMachines={true}
                        testIdPrefix="session-handoff-machine"
                        onSelect={(machine: any) => {
                            setSelectedMachineId(normalizeId(machine?.id) || null);
                        }}
                        onToggleFavorite={(machine: any) => {
                            const machineId = normalizeId(machine?.id);
                            if (!machineId) return;
                            const exists = favoriteMachineIds.includes(machineId);
                            setFavoriteMachinesRaw(exists ? favoriteMachineIds.filter((id: string) => id !== machineId) : [machineId, ...favoriteMachineIds]);
                        }}
                    />
                    <ItemGroup
                        title={t('settingsSession.handoff.workspaceTransfer.groupTitle')}
                        footer={t('settingsSession.handoff.workspaceTransfer.groupFooter')}
                    >
                        <Item
                            testID="session-handoff-workspace-transfer-enabled"
                            title={t('settingsSession.handoff.workspaceTransfer.title')}
                            subtitle={
                                workspaceTransferEnabled
                                    && workspaceTransferPathSafety.allowed
                                    ? t('settingsSession.handoff.workspaceTransfer.enabledSubtitle')
                                    : t('settingsSession.handoff.workspaceTransfer.disabledSubtitle')
                            }
                            icon={<Octicons name="file-directory" size={18} color={theme.colors.textSecondary} />}
                            rightElement={
                                <Switch
                                    value={effectiveWorkspaceTransferEnabled}
                                    disabled={!workspaceTransferPathSafety.allowed}
                                    onValueChange={setWorkspaceTransferEnabled}
                                />
                            }
                            showChevron={false}
                            onPress={() => {
                                if (!workspaceTransferPathSafety.allowed) return;
                                setWorkspaceTransferEnabled(!workspaceTransferEnabled);
                            }}
                        />
                        <DropdownMenu
                            open={openWorkspaceTransferStrategyMenu}
                            onOpenChange={setOpenWorkspaceTransferStrategyMenu}
                            variant="selectable"
                            search={false}
                            selectedId={workspaceTransferStrategy}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            itemTrigger={{
                                title: t('settingsSession.handoff.workspaceTransfer.strategy.title'),
                                subtitle: t('settingsSession.handoff.workspaceTransfer.strategy.subtitle'),
                                icon: <Octicons name="git-branch" size={18} color={theme.colors.textSecondary} />,
                                itemProps: {
                                    disabled: workspaceTransferControlsDisabled,
                                    testID: 'session-handoff-workspace-transfer-strategy-trigger',
                                },
                            }}
                            items={SESSION_HANDOFF_WORKSPACE_TRANSFER_STRATEGY_OPTIONS.map((item) => ({
                                id: item.id,
                                title: t(item.titleKey),
                                subtitle: t(item.subtitleKey),
                            }))}
                            onSelect={(itemId) => {
                                if (workspaceTransferControlsDisabled) return;
                                setWorkspaceTransferStrategy(itemId as 'transfer_snapshot' | 'sync_changes');
                                setOpenWorkspaceTransferStrategyMenu(false);
                            }}
                        />
                        <DropdownMenu
                            open={openConflictPolicyMenu}
                            onOpenChange={setOpenConflictPolicyMenu}
                            variant="selectable"
                            search={false}
                            selectedId={conflictPolicy}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            itemTrigger={{
                                title: t('settingsSession.handoff.conflictPolicy.title'),
                                subtitle: t('settingsSession.handoff.conflictPolicy.subtitle'),
                                icon: <Octicons name="copy" size={18} color={theme.colors.textSecondary} />,
                                itemProps: {
                                    disabled: workspaceTransferControlsDisabled,
                                },
                            }}
                            items={SESSION_HANDOFF_CONFLICT_POLICY_OPTIONS.map((item) => ({
                                id: item.id,
                                title: t(item.titleKey),
                                subtitle: t(item.subtitleKey),
                            }))}
                            onSelect={(itemId) => {
                                if (workspaceTransferControlsDisabled) return;
                                setConflictPolicy(itemId as 'create_sibling_copy' | 'replace_existing');
                                setOpenConflictPolicyMenu(false);
                            }}
                        />
                        <DropdownMenu
                            open={openIgnoredModeMenu}
                            onOpenChange={setOpenIgnoredModeMenu}
                            variant="selectable"
                            search={false}
                            selectedId={includeIgnoredMode}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            itemTrigger={{
                                title: t('settingsSession.handoff.includeIgnoredMode.title'),
                                subtitle: t('settingsSession.handoff.includeIgnoredMode.subtitle'),
                                icon: <Octicons name="filter" size={18} color={theme.colors.textSecondary} />,
                                itemProps: {
                                    disabled: workspaceTransferControlsDisabled,
                                },
                            }}
                            items={SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.map((item) => ({
                                id: item.id,
                                title: t(item.titleKey),
                                subtitle: t(item.subtitleKey),
                            }))}
                            onSelect={(itemId) => {
                                if (workspaceTransferControlsDisabled) return;
                                setIncludeIgnoredMode(itemId as 'exclude' | 'include_selected');
                                setOpenIgnoredModeMenu(false);
                            }}
                        />
                        {includeIgnoredMode === 'include_selected' ? (
                            <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
                                <Text style={{ fontSize: 14, marginBottom: 8, color: theme.colors.textSecondary }}>
                                    {t('settingsSession.handoff.includeIgnoredMode.globsTitle')}
                                </Text>
                                <TextInput
                                    value={ignoredIncludeGlobs.join(', ')}
                                    onChangeText={(value) => {
                                        if (workspaceTransferControlsDisabled) return;
                                        setIgnoredIncludeGlobs(parseSessionHandoffIgnoredIncludeGlobs(value));
                                    }}
                                    placeholder={t('settingsSession.handoff.includeIgnoredMode.globsPlaceholder')}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    editable={!workspaceTransferControlsDisabled}
                                    style={{
                                        minHeight: 44,
                                        borderRadius: 10,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        paddingHorizontal: 12,
                                        paddingVertical: 10,
                                        color: theme.colors.text,
                                    }}
                                />
                            </View>
                        ) : null}
                    </ItemGroup>
                    {isDirectSession ? (
                        <ItemGroup
                            title={t('settingsSession.handoff.directTargetMode.groupTitle')}
                            footer={t('settingsSession.handoff.directTargetMode.groupFooter')}
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
                                    icon: <Octicons name="arrow-switch" size={18} color={theme.colors.textSecondary} />,
                                }}
                                items={SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS.map((item) => ({
                                    id: item.id,
                                    title: t(item.titleKey),
                                    subtitle: t(item.subtitleKey),
                                }))}
                                onSelect={(itemId) => {
                                    setDirectTargetMode(itemId as 'keep_direct' | 'convert_to_persisted');
                                    setOpenDirectTargetModeMenu(false);
                                }}
                            />
                        </ItemGroup>
                    ) : null}
                </ItemList>
            </View>

            <View style={styles.footer}>
                <RoundButton display="inverted" title={t('common.cancel')} onPress={handleCancel} />
                <RoundButton
                    testID="session-handoff-start"
                    title={actionSpec.title}
                    onPress={handleStart}
                    disabled={!selectedMachine || !isMachineOnline(selectedMachine as any)}
                />
            </View>
        </View>
    );
}
