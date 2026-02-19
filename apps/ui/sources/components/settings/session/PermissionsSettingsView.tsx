import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

type PermissionApplyTiming = 'immediate' | 'next_prompt';

function getPermissionApplyTimingSubtitleKey(applyTiming: PermissionApplyTiming): 'settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle' | 'settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle' {
    return applyTiming === 'immediate'
        ? 'settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle'
        : 'settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle';
}

export const PermissionsSettingsView = React.memo(function PermissionsSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const enabledAgentIds = useEnabledAgentIds();

    const [defaultPermissionByAgent, setDefaultPermissionByAgent] = useSettingMutable('sessionDefaultPermissionModeByAgent');
    const [permissionModeApplyTiming, setPermissionModeApplyTiming] = useSettingMutable('sessionPermissionModeApplyTiming');

    const getDefaultPermission = React.useCallback((agent: AgentId): PermissionMode => {
        const raw = (defaultPermissionByAgent as any)?.[agent] as PermissionMode | undefined;
        return (raw ?? 'default') as PermissionMode;
    }, [defaultPermissionByAgent]);

    const setDefaultPermission = React.useCallback((agent: AgentId, mode: PermissionMode) => {
        setDefaultPermissionByAgent({
            ...(defaultPermissionByAgent ?? {}),
            [agent]: mode,
        } as any);
    }, [defaultPermissionByAgent, setDefaultPermissionByAgent]);

    const [openProvider, setOpenProvider] = React.useState<null | AgentId>(null);
    const [openApplyTimingMenu, setOpenApplyTimingMenu] = React.useState<boolean>(false);

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
                        icon: <Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />,
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
        </ItemList>
    );
});

export default PermissionsSettingsView;
