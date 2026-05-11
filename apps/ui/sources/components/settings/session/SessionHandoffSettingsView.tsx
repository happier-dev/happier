import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    normalizeSessionHandoffDefaults,
    parseSessionHandoffIgnoredIncludeGlobs,
    SESSION_HANDOFF_CONFLICT_POLICY_OPTIONS,
    SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS,
    SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS,
    SESSION_HANDOFF_WORKSPACE_TRANSFER_STRATEGY_OPTIONS,
    type SessionHandoffDefaultsV1,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { useSettingMutable } from '@/sync/domains/state/storage';

export const SessionHandoffSettingsView = React.memo(function SessionHandoffSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);
    const [rawDefaults, setRawDefaults] = useSettingMutable('sessionHandoffDefaultsV1');
    const defaults = React.useMemo(() => normalizeSessionHandoffDefaults(rawDefaults), [rawDefaults]);
    const defaultsRef = React.useRef(defaults);
    const [openConflictPolicyMenu, setOpenConflictPolicyMenu] = React.useState(false);
    const [openIgnoredModeMenu, setOpenIgnoredModeMenu] = React.useState(false);
    const [openDirectModeMenu, setOpenDirectModeMenu] = React.useState(false);
    const [openWorkspaceTransferStrategyMenu, setOpenWorkspaceTransferStrategyMenu] = React.useState(false);

    React.useEffect(() => {
        defaultsRef.current = defaults;
    }, [defaults]);

    const updateDefaults = React.useCallback((patch: Partial<SessionHandoffDefaultsV1>) => {
        const next = {
            ...defaultsRef.current,
            ...patch,
        };
        defaultsRef.current = next;
        setRawDefaults(next as any);
    }, [setRawDefaults]);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.handoff.workspaceTransfer.groupTitle')}
                footer={t('settingsSession.handoff.workspaceTransfer.groupFooter')}
            >
                <Item
                    title={t('settingsSession.handoff.workspaceTransfer.title')}
                    subtitle={
                        defaults.workspaceTransferEnabled
                            ? t('settingsSession.handoff.workspaceTransfer.enabledSubtitle')
                            : t('settingsSession.handoff.workspaceTransfer.disabledSubtitle')
                    }
                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<Switch value={defaults.workspaceTransferEnabled} onValueChange={(next) => updateDefaults({ workspaceTransferEnabled: next })} />}
                    showChevron={false}
                    onPress={() => updateDefaults({ workspaceTransferEnabled: !defaults.workspaceTransferEnabled })}
                />
                <DropdownMenu
                    open={openWorkspaceTransferStrategyMenu}
                    onOpenChange={setOpenWorkspaceTransferStrategyMenu}
                    variant="selectable"
                    search={false}
                    selectedId={defaults.workspaceTransferStrategy}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.handoff.workspaceTransfer.strategy.title'),
                        subtitle: t('settingsSession.handoff.workspaceTransfer.strategy.subtitle'),
                        icon: <Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.blue} />,
                    }}
                    items={SESSION_HANDOFF_WORKSPACE_TRANSFER_STRATEGY_OPTIONS.map((item) => ({
                        id: item.id,
                        title: t(item.titleKey),
                        subtitle: t(item.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons
                                    name={item.id === 'sync_changes' ? 'git-compare-outline' : 'archive-outline'}
                                    size={22}
                                    color={theme.colors.text.secondary}
                                />
                            </View>
                        ),
                    }))}
                    onSelect={(itemId) => {
                        updateDefaults({ workspaceTransferStrategy: itemId as SessionHandoffDefaultsV1['workspaceTransferStrategy'] });
                        setOpenWorkspaceTransferStrategyMenu(false);
                    }}
                />
                <DropdownMenu
                    open={openConflictPolicyMenu}
                    onOpenChange={setOpenConflictPolicyMenu}
                    variant="selectable"
                    search={false}
                    selectedId={defaults.conflictPolicy}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.handoff.conflictPolicy.title'),
                        subtitle: t('settingsSession.handoff.conflictPolicy.subtitle'),
                        icon: <Ionicons name="git-compare-outline" size={29} color={theme.colors.accent.orange} />,
                    }}
                    items={SESSION_HANDOFF_CONFLICT_POLICY_OPTIONS.map((item) => ({
                        id: item.id,
                        title: t(item.titleKey),
                        subtitle: t(item.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons
                                    name={item.id === 'replace_existing' ? 'swap-horizontal-outline' : 'copy-outline'}
                                    size={22}
                                    color={theme.colors.text.secondary}
                                />
                            </View>
                        ),
                    }))}
                    onSelect={(itemId) => {
                        updateDefaults({ conflictPolicy: itemId as SessionHandoffDefaultsV1['conflictPolicy'] });
                        setOpenConflictPolicyMenu(false);
                    }}
                />
                <DropdownMenu
                    open={openIgnoredModeMenu}
                    onOpenChange={setOpenIgnoredModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={defaults.includeIgnoredMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.handoff.includeIgnoredMode.title'),
                        subtitle: t('settingsSession.handoff.includeIgnoredMode.subtitle'),
                        icon: <Ionicons name="filter-outline" size={29} color={theme.colors.accent.indigo} />,
                    }}
                    items={SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.map((item) => ({
                        id: item.id,
                        title: t(item.titleKey),
                        subtitle: t(item.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons
                                    name={item.id === 'include_selected' ? 'filter-outline' : 'eye-off-outline'}
                                    size={22}
                                    color={theme.colors.text.secondary}
                                />
                            </View>
                        ),
                    }))}
                    onSelect={(itemId) => {
                        updateDefaults({ includeIgnoredMode: itemId as SessionHandoffDefaultsV1['includeIgnoredMode'] });
                        setOpenIgnoredModeMenu(false);
                    }}
                />
                {defaults.includeIgnoredMode === 'include_selected' ? (
                    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
                        <Text style={{ fontSize: 14, marginBottom: 8, color: theme.colors.text.secondary }}>
                            {t('settingsSession.handoff.includeIgnoredMode.globsTitle')}
                        </Text>
                        <TextInput
                            value={defaults.ignoredIncludeGlobs.join(', ')}
                            onChangeText={(value) => updateDefaults({ ignoredIncludeGlobs: parseSessionHandoffIgnoredIncludeGlobs(value) })}
                            placeholder={t('settingsSession.handoff.includeIgnoredMode.globsPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={{
                                minHeight: 44,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                color: theme.colors.text.primary,
                            }}
                        />
                    </View>
                ) : null}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.handoff.directTargetMode.groupTitle')}
                footer={t('settingsSession.handoff.directTargetMode.groupFooter')}
            >
                <DropdownMenu
                    open={openDirectModeMenu}
                    onOpenChange={setOpenDirectModeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={defaults.directTargetMode}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.handoff.directTargetMode.title'),
                        subtitle: t('settingsSession.handoff.directTargetMode.subtitle'),
                        icon: <Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.accent.green} />,
                    }}
                    items={SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS.map((item) => ({
                        id: item.id,
                        title: t(item.titleKey),
                        subtitle: t(item.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons
                                    name={item.id === 'convert_to_persisted' ? 'save-outline' : 'arrow-redo-outline'}
                                    size={22}
                                    color={theme.colors.text.secondary}
                                />
                            </View>
                        ),
                    }))}
                    onSelect={(itemId) => {
                        updateDefaults({ directTargetMode: itemId as SessionHandoffDefaultsV1['directTargetMode'] });
                        setOpenDirectModeMenu(false);
                    }}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default SessionHandoffSettingsView;
