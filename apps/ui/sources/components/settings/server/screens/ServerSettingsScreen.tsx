import * as React from 'react';
import type { ScrollView, ScrollViewProps } from 'react-native';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance';
import { SavedServersSection } from '@/components/settings/server/sections/SavedServersSection';
import { AddTargetsSection } from '@/components/settings/server/sections/AddTargetsSection';
import { ServerGroupsSection } from '@/components/settings/server/sections/ServerGroupsSection';
import { ServerRetentionSection } from '@/components/settings/server/sections/ServerRetentionSection';
import { useServerSettingsScreenController } from '@/components/settings/server/hooks/useServerSettingsScreenController';

const stylesheet = StyleSheet.create((_theme) => ({
    itemListContainer: {
        flex: 1,
    },
}));

type KeyboardAwareItemListProps = ScrollViewProps & Readonly<{
    children?: React.ReactNode;
}>;

const ServerSettingsKeyboardAwareItemList = React.forwardRef<ScrollView, KeyboardAwareItemListProps>(
    function ServerSettingsKeyboardAwareItemList({ children, ...props }, ref) {
        return (
            <ItemList ref={ref} {...props}>
                {children}
            </ItemList>
        );
    },
);

export function ServerSettingsScreen() {
    useUnistyles();
    const styles = stylesheet;
    const controller = useServerSettingsScreenController();

    return (
        <KeyboardAwareScrollView
            style={styles.itemListContainer}
            ScrollViewComponent={ServerSettingsKeyboardAwareItemList}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
        >
            <SavedServersSection
                servers={controller.servers}
                serverGroups={controller.serverGroups}
                activeServerId={controller.activeServerId}
                deviceDefaultServerId={controller.deviceDefaultServerId}
                activeTargetKey={controller.activeTargetKey}
                authStatusByServerId={controller.authStatusByServerId}
                onSwitch={controller.onSwitchServer}
                onSwitchGroup={controller.onSwitchGroup}
                onRenameGroup={controller.onRenameGroup}
                onRemoveGroup={controller.onRemoveGroup}
                onRename={controller.onRenameServer}
                onRemove={controller.onRemoveServer}
            />

            <ServerRetentionSection serverId={controller.activeServerId || null} />

            <AddTargetsSection
                autoMode={controller.autoMode}
                inputUrl={controller.inputUrl}
                inputName={controller.inputName}
                error={controller.error}
                isValidating={controller.isValidating}
                canResetServer={controller.canResetServer}
                prefillHint={controller.addServerPrefillHint}
                defaultExpanded={controller.addServerDefaultExpanded}
                onChangeUrl={controller.onChangeUrl}
                onChangeName={controller.onChangeName}
                onResetServer={controller.onResetServer}
                onAddServer={controller.onAddServer}
                servers={controller.servers}
                activeServerId={controller.activeServerId}
                onCreateServerGroup={controller.onCreateServerGroup}
            />

            {controller.serverGroups.length > 0 ? (
                <ServerGroupsSection
                    groupSelectionEnabled={controller.groupSelectionEnabled}
                    setGroupSelectionEnabled={controller.setGroupSelectionEnabled}
                    groupSelectionPresentation={controller.groupSelectionPresentation}
                    activeServerGroupId={controller.activeServerGroupId}
                    selectedGroupServerIds={controller.selectedGroupServerIds}
                    servers={controller.servers}
                    onToggleGroupPresentation={controller.onToggleGroupPresentation}
                    onToggleGroupServer={controller.onToggleGroupServer}
                />
            ) : null}
        </KeyboardAwareScrollView>
    );
}
