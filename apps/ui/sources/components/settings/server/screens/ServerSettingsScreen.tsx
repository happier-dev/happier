import * as React from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { SavedServersSection } from '@/components/settings/server/sections/SavedServersSection';
import { AddTargetsSection } from '@/components/settings/server/sections/AddTargetsSection';
import { ServerGroupsSection } from '@/components/settings/server/sections/ServerGroupsSection';
import { useServerSettingsScreenController } from '@/components/settings/server/hooks/useServerSettingsScreenController';

const stylesheet = StyleSheet.create((_theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
}));

export function ServerSettingsScreen() {
    useUnistyles();
    const styles = stylesheet;
    const controller = useServerSettingsScreenController();

    return (
        <>
            <Stack.Screen options={controller.screenOptions} />
            <KeyboardAvoidingView
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
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

                    <AddTargetsSection
                        autoMode={controller.autoMode}
                        inputUrl={controller.inputUrl}
                        inputName={controller.inputName}
                        error={controller.error}
                        isValidating={controller.isValidating}
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
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
