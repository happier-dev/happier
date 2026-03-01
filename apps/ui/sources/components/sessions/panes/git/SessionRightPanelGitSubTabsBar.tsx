import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type GitSubTabId = 'commit' | 'update' | 'history';

export type SessionRightPanelGitSubTabsBarProps = Readonly<{
    tabs: ReadonlyArray<{ id: GitSubTabId; label: string }>;
    activeSubTabId: GitSubTabId;
    onSelectSubTab: (subTabId: GitSubTabId) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    inner: {
        flexDirection: 'row',
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        overflow: 'hidden',
    },
    tab: {
        flex: 1,
        paddingVertical: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabActive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tabLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    tabLabelActive: {
        color: theme.colors.text,
    },
}));

export const SessionRightPanelGitSubTabsBar = React.memo((props: SessionRightPanelGitSubTabsBarProps) => {
    const styles = stylesheet;
    useUnistyles();

    const Tab = (p: { id: GitSubTabId; label: string }) => (
        <Pressable
            testID={`session-rightpanel-git-subtab:${p.id}`}
            onPress={() => props.onSelectSubTab(p.id)}
            style={[styles.tab, props.activeSubTabId === p.id ? styles.tabActive : null]}
            accessibilityRole="button"
        >
            <Text style={[styles.tabLabel, props.activeSubTabId === p.id ? styles.tabLabelActive : null]}>
                {p.label}
            </Text>
        </Pressable>
    );

    return (
        <View style={styles.container}>
            <View style={styles.inner}>
                {props.tabs.map((tab) => (
                    <Tab key={tab.id} id={tab.id} label={tab.label} />
                ))}
            </View>
        </View>
    );
});
