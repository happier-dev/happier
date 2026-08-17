import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingRight: 8,
    },
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
}));

export const ProjectHeaderActions = React.memo((props: Readonly<{
    testIdPrefix: string;
    showWorktreesButton: boolean;
    showWorkspaceExperienceButton?: boolean;
    workspaceExperienceToggleA11yLabel?: string;
    onToggleWorkspaceExperience?: () => void;
    onOpenWorktrees?: () => void;
    onOpenTerminal: () => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            {props.showWorkspaceExperienceButton && props.onToggleWorkspaceExperience ? (
                <Pressable
                    testID={`${props.testIdPrefix}-toggle-workspace-experience`}
                    onPress={props.onToggleWorkspaceExperience}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel={props.workspaceExperienceToggleA11yLabel}
                >
                    <Icon name="arrows-left-right" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}
            {props.showWorktreesButton && props.onOpenWorktrees ? (
                <Pressable
                    testID={`${props.testIdPrefix}-open-worktrees`}
                    onPress={props.onOpenWorktrees}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.branchMenu.category.worktrees')}
                >
                    <Icon name="git-branch" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null}
            <Pressable
                testID={`${props.testIdPrefix}-open-terminal`}
                onPress={props.onOpenTerminal}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel={t('settings.terminal')}
            >
                <Icon name="terminal" size={16} color={theme.colors.text.secondary} />
            </Pressable>
        </View>
    );
});
