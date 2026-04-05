import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
}));

export const ProjectHeaderActions = React.memo((props: Readonly<{
    testIdPrefix: string;
    showWorktreesButton: boolean;
    onOpenWorktrees?: () => void;
    onOpenTerminal: () => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            {props.showWorktreesButton && props.onOpenWorktrees ? (
                <Pressable
                    testID={`${props.testIdPrefix}-open-worktrees`}
                    onPress={props.onOpenWorktrees}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.branchMenu.category.worktrees')}
                >
                    <Octicons name="git-branch" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            ) : null}
            <Pressable
                testID={`${props.testIdPrefix}-open-terminal`}
                onPress={props.onOpenTerminal}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel={t('settings.terminal')}
            >
                <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});
