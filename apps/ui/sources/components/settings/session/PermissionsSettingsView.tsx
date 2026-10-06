import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSettingMutable, useSettingsSelector } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolvePermissionPromptSurface } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { supportsDirectTranscriptStorageForNewSession } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { readAccountTranscriptStorageDefaults, type SessionTranscriptStorageMode } from '@/sync/domains/session/transcriptStorageDefaults';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { Icon } from '@/components/ui/icons/Icon';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { Item } from '@/components/ui/lists/Item';
import { PERMISSIONS_SETTINGS } from '@/components/settings/session/permissionsSettings';

type PermissionApplyTiming = 'immediate' | 'next_prompt';
type PermissionPromptSurfaceMenuOption = 'composer' | 'transcript';

const USE_GLOBAL_STORAGE = 'global';
const TRANSCRIPT_STORAGE_MODES = ['persisted', 'direct'] as const satisfies readonly SessionTranscriptStorageMode[];
type AgentStorageChoice = SessionTranscriptStorageMode | typeof USE_GLOBAL_STORAGE;

export const PermissionsSettingsView = React.memo(function PermissionsSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const enabledAgentIds = useEnabledAgentIds();
    const settings = useSettingsSelector((settings) => ({
        opencodeBackendMode: (settings as Record<string, unknown>).opencodeBackendMode,
    }));
    const externalSessionsEnabled = useFeatureEnabled('sessions.direct');
    const transcriptStorageSettings = React.useMemo(() => ({
        opencodeBackendMode: (settings as Record<string, unknown>).opencodeBackendMode,
    }), [settings]);

    const [defaultPermissionByTargetKey, setDefaultPermissionByTargetKey] = useSettingMutable('sessionDefaultPermissionModeByTargetKey');
    const [permissionModeApplyTiming, setPermissionModeApplyTiming] = useSettingMutable('sessionPermissionModeApplyTiming');
    const [permissionPromptSurface, setPermissionPromptSurface] = useSettingMutable('permissionPromptSurface');
    const [defaultTranscriptStorageMode, setDefaultTranscriptStorageMode] = useSettingMutable('newSessionDefaultPersistenceModeV1');
    const [defaultTranscriptStorageModeByTargetKey, setDefaultTranscriptStorageModeByTargetKey] = useSettingMutable('newSessionDefaultPersistenceModeByTargetKeyV1');

    const getDefaultPermission = React.useCallback((agent: AgentId): PermissionMode => {
        const targetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: agent });
        const raw = (defaultPermissionByTargetKey as any)?.[targetKey] as PermissionMode | undefined;
        return (raw ?? 'default') as PermissionMode;
    }, [defaultPermissionByTargetKey]);

    const setDefaultPermission = React.useCallback((agent: AgentId, mode: PermissionMode) => {
        const targetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: agent });
        setDefaultPermissionByTargetKey({
            ...(defaultPermissionByTargetKey ?? {}),
            [targetKey]: mode,
        } as any);
    }, [defaultPermissionByTargetKey, setDefaultPermissionByTargetKey]);

    const supportedDirectAgentIds = React.useMemo(() => {
        return enabledAgentIds.filter((agentId) => supportsDirectTranscriptStorageForNewSession({
            agentId,
            settings: transcriptStorageSettings,
        }));
    }, [enabledAgentIds, transcriptStorageSettings]);

    const accountTranscriptStorageDefaults = React.useMemo(() => {
        const enabledBackendTargets = supportedDirectAgentIds.map((agentId) => ({ kind: 'backend', backendId: agentId } as const));
        return readAccountTranscriptStorageDefaults({
            globalDefault: defaultTranscriptStorageMode,
            byTargetKey: defaultTranscriptStorageModeByTargetKey,
            enabledBackendTargets,
        });
    }, [defaultTranscriptStorageMode, defaultTranscriptStorageModeByTargetKey, supportedDirectAgentIds]);

    const setAgentDefaultTranscriptStorage = React.useCallback((agent: AgentId, mode: SessionTranscriptStorageMode | null) => {
        const targetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: agent });
        const next = {
            ...(defaultTranscriptStorageModeByTargetKey ?? {}),
        } as Record<string, SessionTranscriptStorageMode>;

        if (mode === null) {
            delete next[targetKey];
        } else {
            next[targetKey] = mode;
        }

        setDefaultTranscriptStorageModeByTargetKey(next as any);
    }, [defaultTranscriptStorageModeByTargetKey, setDefaultTranscriptStorageModeByTargetKey]);

    const [openProvider, setOpenProvider] = React.useState<null | AgentId>(null);

    const normalizedApplyTiming: PermissionApplyTiming = permissionModeApplyTiming === 'immediate' ? 'immediate' : 'next_prompt';
    const normalizedPromptSurface: PermissionPromptSurfaceMenuOption =
        resolvePermissionPromptSurface(permissionPromptSurface);

    const storageLabel = (mode: SessionTranscriptStorageMode) => mode === 'direct'
        ? t('sessionsList.storageDirectTab')
        : t('sessionsList.storagePersistedTab');
    const storageDescription = (mode: SessionTranscriptStorageMode) => mode === 'direct'
        ? t('settingsSession.defaultStorage.directSubtitle')
        : t('settingsSession.defaultStorage.persistedSubtitle');
    const globalStorageLabel = storageLabel(accountTranscriptStorageDefaults.globalDefault);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settings.permissionsSubtitle')} />
            <SettingAnchor setting={PERMISSIONS_SETTINGS.settings.defaultPermissions}>
                <ItemGroup title={t('settingsSession.defaultPermissions.title')} description={t('settingsSession.defaultPermissions.footer')}>
                    {enabledAgentIds.map((agentId) => {
                        const core = getAgentCore(agentId);
                        if (!core) return null;
                        const mode = getDefaultPermission(agentId);
                        return (
                            <DropdownMenu
                                key={agentId}
                                open={openProvider === agentId}
                                onOpenChange={(next) => setOpenProvider(next ? agentId : null)}
                                variant="selectable"
                                search={false}
                                selectedId={mode as any}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(core.displayNameKey),
                                    icon: <AgentIcon agentId={agentId} size={22} />,
                                    // The field shows the mode; a subtitle repeating it adds nothing.
                                    showSelectedSubtitle: false,
                                    itemProps: { testID: `settings-permissions-default-${agentId}` },
                                }}
                                items={getPermissionModeOptionsForAgentType(agentId as any).map((opt) => ({
                                    id: opt.value,
                                    title: opt.label,
                                    subtitle: opt.description,
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Icon name={opt.icon as any} size={20} color={theme.colors.text.secondary} />
                                        </View>
                                    ),
                                }))}
                                onSelect={(id) => {
                                    setDefaultPermission(agentId, id as any);
                                    setOpenProvider(null);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            </SettingAnchor>

            <ItemGroup
                title={t('settingsSessionPages.permissions.duringSessionSection')}
                description={t('settingsSessionPages.permissions.duringSessionDescription')}
            >
                <SettingAnchor setting={PERMISSIONS_SETTINGS.settings.promptSurface}>
                    <SegmentedChoiceItem<PermissionPromptSurfaceMenuOption>
                        subtitleLines={0}
                        testID="settings-permissions-prompt-surface"
                        testIDPrefix="settings-permissions-prompt-surface"
                        title={t(PERMISSIONS_SETTINGS.settings.promptSurface.titleKey)}
                        options={[
                            { id: 'composer', label: t('settingsSessionPages.permissions.promptSurfaceComposer'), description: t('settingsSession.permissions.promptSurface.composerSubtitle') },
                            { id: 'transcript', label: t('settingsSession.permissions.promptSurface.transcriptTitle'), description: t('settingsSession.permissions.promptSurface.transcriptSubtitle') },
                        ]}
                        value={normalizedPromptSurface}
                        onChange={setPermissionPromptSurface}
                    />
                </SettingAnchor>
                <SettingAnchor setting={PERMISSIONS_SETTINGS.settings.applyPermissionChanges}>
                    <SegmentedChoiceItem<PermissionApplyTiming>
                        subtitleLines={0}
                        testID="settings-permissions-apply-timing"
                        testIDPrefix="settings-permissions-apply-timing"
                        title={t(PERMISSIONS_SETTINGS.settings.applyPermissionChanges.titleKey)}
                        options={[
                            { id: 'immediate', label: t('settingsSessionPages.permissions.applyImmediately'), description: t('settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle') },
                            { id: 'next_prompt', label: t('settingsSessionPages.permissions.applyNextMessage'), description: t('settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle') },
                        ]}
                        value={normalizedApplyTiming}
                        onChange={setPermissionModeApplyTiming}
                    />
                </SettingAnchor>
            </ItemGroup>

            {externalSessionsEnabled ? (
                <SettingSection section={PERMISSIONS_SETTINGS.sectionRefs.defaultStorage}>
                    <ItemGroup title={t('settingsSession.defaultStorage.title')} description={t('settingsSession.defaultStorage.footer')}>
                        {supportedDirectAgentIds.length > 0 ? (
                            <>
                                <SettingAnchor setting={PERMISSIONS_SETTINGS.settings.global}>
                                    <SegmentedChoiceItem<SessionTranscriptStorageMode>
                                        subtitleLines={0}
                                        testID="settings-permissions-storage-global"
                                        testIDPrefix="settings-permissions-storage-global"
                                        title={t(PERMISSIONS_SETTINGS.settings.global.titleKey)}
                                        options={TRANSCRIPT_STORAGE_MODES.map((mode) => ({ id: mode, label: storageLabel(mode), description: storageDescription(mode) }))}
                                        value={accountTranscriptStorageDefaults.globalDefault}
                                        onChange={setDefaultTranscriptStorageMode}
                                    />
                                </SettingAnchor>

                                {supportedDirectAgentIds.map((agentId) => {
                                    const core = getAgentCore(agentId);
                                    if (!core) return null;
                                    const override = accountTranscriptStorageDefaults.byTargetKey[
                                        resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentId })
                                    ] ?? null;
                                    return (
                                        <SegmentedChoiceItem<AgentStorageChoice>
                                            subtitleLines={0}
                                            key={`storage-${agentId}`}
                                            testID={`settings-permissions-storage-${agentId}`}
                                            testIDPrefix={`settings-permissions-storage-${agentId}`}
                                            title={t(core.displayNameKey)}
                                            icon={<AgentIcon agentId={agentId} size={22} />}
                                            options={[
                                                {
                                                    id: USE_GLOBAL_STORAGE,
                                                    label: t('settingsSessionPages.permissions.storageUseDefault'),
                                                    description: t('settingsSession.defaultStorage.globalSubtitle', { label: globalStorageLabel }),
                                                },
                                                ...TRANSCRIPT_STORAGE_MODES.map((mode) => ({ id: mode, label: storageLabel(mode), description: storageDescription(mode) })),
                                            ]}
                                            value={override ?? USE_GLOBAL_STORAGE}
                                            onChange={(next) => setAgentDefaultTranscriptStorage(agentId, next === USE_GLOBAL_STORAGE ? null : next)}
                                        />
                                    );
                                })}
                            </>
                        ) : (
                            <Item
                                testID="settings-permissions-storage-unavailable"
                                title={t('settingsSession.defaultStorage.noDirectAgents')}
                                titleLines={0}
                                mode="info"
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                </SettingSection>
            ) : null}
        </ItemList>
    );
});

export default PermissionsSettingsView;
