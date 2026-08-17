import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import type { RightSidebarTabDefinition } from './rightSidebarTabRegistry';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    tabList: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    tab: {
        width: 44,
        height: 44,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    tabActive: {
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        borderColor: theme.colors.border.strong,
    },
    tabDisabled: {
        opacity: 0.45,
    },
}));

export function RightSidebarIconTabBar<TTabId extends string>(props: Readonly<{
    tabs: readonly RightSidebarTabDefinition[];
    activeTabId: TTabId;
    onSelectTab: (tabId: TTabId) => void;
    testIDPrefix?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'right-sidebar-tab';

    return (
        <View
            accessibilityRole="tablist"
            style={styles.tabList}
        >
            {props.tabs.map((tab) => {
                const active = tab.id === props.activeTabId;
                const label = tab.owner === 'builtin' ? t(tab.labelKey) : tab.label;
                const disabled = Boolean(tab.disabledReason);
                return (
                    <Pressable
                        key={tab.id}
                        testID={`${testIDPrefix}:${tab.id}`}
                        onPress={() => {
                            if (!disabled) {
                                props.onSelectTab(tab.id as TTabId);
                            }
                        }}
                        style={[styles.tab, active ? styles.tabActive : null, disabled ? styles.tabDisabled : null]}
                        accessibilityRole="tab"
                        accessibilityLabel={label}
                        accessibilityHint={label}
                        accessibilityState={{ selected: active, disabled }}
                        aria-selected={active}
                        disabled={disabled}
                    >
                        <Icon
                            name={tab.icon}
                            // A tab is the pane's primary control and the only thing naming it —
                            // there is no label underneath. At the list-row step it read as a hint
                            // rather than a switch, adrift in a 44pt target.
                            size={ICON_SIZE.md}
                            color={active ? theme.colors.text.primary : theme.colors.text.secondary}
                        />
                    </Pressable>
                );
            })}
        </View>
    );
}
