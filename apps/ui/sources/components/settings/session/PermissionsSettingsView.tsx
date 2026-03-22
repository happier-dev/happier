import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolvePermissionPromptSurface } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { getPermissionApplyTimingSubtitleKey } from '@/components/settings/session/sessionI18n';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { supportsDirectTranscriptStorageForNewSession } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { readAccountTranscriptStorageDefaults, type SessionTranscriptStorageMode } from '@/sync/domains/session/transcriptStorageDefaults';

type PermissionApplyTiming = 'immediate' | 'next_prompt';
type PermissionPromptSurfaceMenuOption = 'composer' | 'transcript';

export const PermissionsSettingsView = React.memo(function PermissionsSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const enabledAgentIds = useEnabledAgentIds();
    const settings = useSettings();
    const directSessionsEnabled = useFeatureEnabled('sessions.direct');
    const transcriptStorageSettings = React.useMemo(() => ({
        opencodeBackendMode: (settings as Record<string, unknown>).opencodeBackendMode,
    }), [settings]);

    const [defaultPermissionByTargetKey, setDefaultPermissionByTargetKey] = useSettingMutable('sessionDefaultPermissionModeByTargetKey');
    const [permissionModeApplyTiming, setPermissionModeApplyTiming] = useSettingMutable('sessionPermissionModeApplyTiming');
    const [permissionPromptSurface, setPermissionPromptSurface] = useSettingMutable('permissionPromptSurface');
    const [defaultTranscriptStorageMode, setDefaultTranscriptStorageMode] = useSettingMutable('newSessionDefaultPersistenceModeV1');
    const [defaultTranscriptStorageModeByTargetKey, setDefaultTranscriptStorageModeByTargetKey] = useSettingMutable('newSessionDefaultPersistenceModeByTargetKeyV1');

    const getDefaultPermission = React.useCallback((agent: AgentId): PermissionMode => {
        const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: agent });
        const raw = (defaultPermissionByTargetKey as any)?.[targetKey] as PermissionMode | undefined;
        return (raw ?? 'default') as PermissionMode;
    }, [defaultPermissionByTargetKey]);

    const setDefaultPermission = React.useCallback((agent: AgentId, mode: PermissionMode) => {
        const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: agent });
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
        const enabledBackendTargets: BackendTargetRefV1[] = supportedDirectAgentIds.map((agentId) => ({
            kind: 'builtInAgent',
            agentId,
        }));
        return readAccountTranscriptStorageDefaults({
            globalDefault: defaultTranscriptStorageMode,
            byTargetKey: defaultTranscriptStorageModeByTargetKey,
            enabledBackendTargets,
        });
    }, [defaultTranscriptStorageMode, defaultTranscriptStorageModeByTargetKey, supportedDirectAgentIds]);

    const setAgentDefaultTranscriptStorage = React.useCallback((agent: AgentId, mode: SessionTranscriptStorageMode | null) => {
        const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: agent });
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
    const [openApplyTimingMenu, setOpenApplyTimingMenu] = React.useState<boolean>(false);
    const [openPromptSurfaceMenu, setOpenPromptSurfaceMenu] = React.useState<boolean>(false);
    const [openStorageProvider, setOpenStorageProvider] = React.useState<null | AgentId>(null);
    const [openStorageGlobalMenu, setOpenStorageGlobalMenu] = React.useState<boolean>(false);

    const applyTimingOptions: Array<{ key: PermissionApplyTiming; title: string; subtitle: string }> = [
        {
            key: 'immediate',
            title: t('settingsSession.permissions.applyTiming.immediateTitle'),
            subtitle: t('settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle'),
        },
        {
            key: 'next_prompt',
            title: t('settingsSession.permissions.applyTiming.nextPromptTitle'),
            subtitle: t('settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle'),
        },
    ];

    const normalizedApplyTiming: PermissionApplyTiming = permissionModeApplyTiming === 'immediate' ? 'immediate' : 'next_prompt';
    const applyTimingLabel = applyTimingOptions.find((opt) => opt.key === normalizedApplyTiming)?.title
        ?? t(getPermissionApplyTimingSubtitleKey(normalizedApplyTiming));

    const normalizedPromptSurface: PermissionPromptSurfaceMenuOption =
        resolvePermissionPromptSurface(permissionPromptSurface);

    const promptSurfaceOptions: Array<{ key: PermissionPromptSurfaceMenuOption; title: string; subtitle: string }> = [
        {
            key: 'composer',
            title: t('settingsSession.permissions.promptSurface.composerTitle'),
            subtitle: t('settingsSession.permissions.promptSurface.composerSubtitle'),
        },
        {
            key: 'transcript',
            title: t('settingsSession.permissions.promptSurface.transcriptTitle'),
            subtitle: t('settingsSession.permissions.promptSurface.transcriptSubtitle'),
        },
    ];

    const transcriptStorageOptions: Array<{ key: SessionTranscriptStorageMode; title: string; subtitle: string }> = [
        {
            key: 'persisted',
            title: t('sessionsList.storagePersistedTab'),
            subtitle: t('settingsSession.defaultStorage.persistedSubtitle'),
        },
        {
            key: 'direct',
            title: t('sessionsList.storageDirectTab'),
            subtitle: t('settingsSession.defaultStorage.directSubtitle'),
        },
    ];

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.defaultPermissions.applyPermissionChangesTitle')}
                footer={t('settingsSession.permissions.applyChangesFooter')}
            >
                <DropdownMenu
                    open={openApplyTimingMenu}
                    onOpenChange={setOpenApplyTimingMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedApplyTiming as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.defaultPermissions.applyPermissionChangesTitle'),
                        icon: <Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.success} />,
                        // Keep the compact label as a fallback; selected option subtitle will override by default.
                        subtitle: applyTimingLabel,
                    }}
                    items={applyTimingOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="options-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setPermissionModeApplyTiming(id as any);
                        setOpenApplyTimingMenu(false);
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.permissions.promptSurfaceTitle')}
                footer={t('settingsSession.permissions.promptSurfaceFooter')}
            >
                <DropdownMenu
                    open={openPromptSurfaceMenu}
                    onOpenChange={setOpenPromptSurfaceMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedPromptSurface as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.permissions.promptSurfaceTitle'),
                        icon: <Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />,
                        subtitle: promptSurfaceOptions.find((opt) => opt.key === normalizedPromptSurface)?.title ?? normalizedPromptSurface,
                    }}
                    items={promptSurfaceOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="chatbox-ellipses-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setPermissionPromptSurface(id as any);
                        setOpenPromptSurfaceMenu(false);
                    }}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.defaultPermissions.title')} footer={t('settingsSession.defaultPermissions.footer')}>
                {enabledAgentIds.map((agentId, index) => {
                    const core = getAgentCore(agentId);
                    const mode = getDefaultPermission(agentId);
                    const showDivider = index < enabledAgentIds.length - 1;
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
                                icon: <Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />,
                                itemProps: { showDivider },
                            }}
                            items={getPermissionModeOptionsForAgentType(agentId as any).map((opt) => ({
                                id: opt.value,
                                title: opt.label,
                                subtitle: opt.description,
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name={opt.icon as any} size={22} color={theme.colors.textSecondary} />
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

            {directSessionsEnabled && supportedDirectAgentIds.length > 0 ? (
                <ItemGroup title={t('settingsSession.defaultStorage.title')} footer={t('settingsSession.defaultStorage.footer')}>
                    <DropdownMenu
                        open={openStorageGlobalMenu}
                        onOpenChange={setOpenStorageGlobalMenu}
                        variant="selectable"
                        search={false}
                        selectedId={accountTranscriptStorageDefaults.globalDefault as any}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsSession.defaultStorage.globalTitle'),
                            icon: <Ionicons name="layers-outline" size={29} color={theme.colors.textSecondary} />,
                            subtitle: transcriptStorageOptions.find((opt) => opt.key === accountTranscriptStorageDefaults.globalDefault)?.title
                                ?? t('sessionsList.storagePersistedTab'),
                        }}
                        items={transcriptStorageOptions.map((opt) => ({
                            id: opt.key,
                            title: opt.title,
                            subtitle: opt.subtitle,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name={opt.key === 'direct' ? 'radio-outline' : 'save-outline'} size={22} color={theme.colors.textSecondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            setDefaultTranscriptStorageMode(id as SessionTranscriptStorageMode);
                            setOpenStorageGlobalMenu(false);
                        }}
                    />

                    {supportedDirectAgentIds.map((agentId, index) => {
                        const core = getAgentCore(agentId);
                        const override = accountTranscriptStorageDefaults.byTargetKey[
                            buildBackendTargetKey({ kind: 'builtInAgent', agentId })
                        ] ?? null;
                        const selectedMode = override ?? accountTranscriptStorageDefaults.globalDefault;
                        const showDivider = index < supportedDirectAgentIds.length - 1;
                        return (
                            <DropdownMenu
                                key={`storage-${agentId}`}
                                open={openStorageProvider === agentId}
                                onOpenChange={(next) => setOpenStorageProvider(next ? agentId : null)}
                                variant="selectable"
                                search={false}
                                selectedId={(override ?? '__global__') as any}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: t(core.displayNameKey),
                                    icon: <Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />,
                                    subtitle: override
                                        ? (transcriptStorageOptions.find((opt) => opt.key === override)?.title ?? t('sessionsList.storagePersistedTab'))
                                        : t('settingsSession.defaultStorage.globalSubtitle', {
                                            label: transcriptStorageOptions.find((opt) => opt.key === accountTranscriptStorageDefaults.globalDefault)?.title
                                                ?? t('sessionsList.storagePersistedTab'),
                                        }),
                                    itemProps: { showDivider },
                                }}
                                items={[
                                    {
                                        id: '__global__',
                                        title: t('settingsSession.defaultStorage.useGlobalDefault'),
                                        subtitle: t('settingsSession.defaultStorage.currently', {
                                            label: transcriptStorageOptions.find((opt) => opt.key === accountTranscriptStorageDefaults.globalDefault)?.title
                                                ?? t('sessionsList.storagePersistedTab'),
                                        }),
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    },
                                    ...transcriptStorageOptions.map((opt) => ({
                                        id: opt.key,
                                        title: opt.title,
                                        subtitle: opt.subtitle,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name={opt.key === 'direct' ? 'radio-outline' : 'save-outline'} size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    })),
                                ]}
                                onSelect={(id) => {
                                    setAgentDefaultTranscriptStorage(agentId, id === '__global__' ? null : id as SessionTranscriptStorageMode);
                                    setOpenStorageProvider(null);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

export default PermissionsSettingsView;
