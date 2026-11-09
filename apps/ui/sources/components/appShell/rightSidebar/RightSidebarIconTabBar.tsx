import * as React from 'react';
import { I18nManager, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveHappierTabKeySelection } from '@happier-dev/plugin-ui/presentation';

import { getRightSidebarTabLabel } from './rightSidebarTabRegistry';
import type { RightSidebarTabDefinition } from './rightSidebarTabRegistry';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';

/** The drawn tab square; the platform touch floor grows only its press frame. */
const RIGHT_SIDEBAR_TAB_SIZE_PX = 32;

const stylesheet = StyleSheet.create((theme) => ({
    tabList: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    marker: {
        position: 'absolute', left: 0, right: 0, bottom: -8,
        height: 2, borderRadius: 1, backgroundColor: theme.colors.text.primary,
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
    const controls = React.useRef(new Map<string, { focus: () => void }>());
    const keyTabs = React.useMemo(() => props.tabs.map((tab) => ({ ...tab, disabled: Boolean(tab.disabledReason) })), [props.tabs]);
    const activeIndex = props.tabs.findIndex((tab) => tab.id === props.activeTabId && !tab.disabledReason);
    const focusIndex = activeIndex < 0 ? keyTabs.findIndex((tab) => !tab.disabled) : activeIndex;

    return (
        <ScrollView
            horizontal
            accessibilityRole="tablist"
            contentContainerStyle={styles.tabList}
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
        >
            {props.tabs.map((tab, index) => {
                const active = tab.id === props.activeTabId;
                const label = getRightSidebarTabLabel(tab);
                const disabled = Boolean(tab.disabledReason);
                return (
                    <IconButton
                        key={tab.id}
                        testID={`${testIDPrefix}:${tab.id}`}
                        onPress={() => {
                            if (!disabled) {
                                props.onSelectTab(tab.id as TTabId);
                            }
                        }}
                        variant="plain"
                        size={RIGHT_SIDEBAR_TAB_SIZE_PX}
                        interactiveTargetGapPx={theme.space.s6}
                        selected={active}
                        selectedBackground={false}
                        accessibilityRole="tab"
                        accessibilityLabel={label}
                        tooltip={label}
                        disabled={disabled}
                        tabIndex={index === focusIndex ? 0 : -1}
                        controlRef={(control) => {
                            if (control) controls.current.set(tab.id, control);
                            else controls.current.delete(tab.id);
                        }}
                        onKeyDown={(key) => {
                            const nextIndex = resolveHappierTabKeySelection({ tabs: keyTabs, currentIndex: index, key, rtl: I18nManager.isRTL });
                            if (nextIndex === null || nextIndex < 0) return false;
                            const next = props.tabs[nextIndex]!;
                            props.onSelectTab(next.id as TTabId);
                            controls.current.get(next.id)?.focus();
                            return true;
                        }}
                        icon={<View pointerEvents="none"><Icon
                            name={tab.icon}
                            // A tab is the pane's primary control and the only thing naming it —
                            // there is no label underneath. At the list-row step it read as a hint
                            // rather than a switch, adrift in a 44pt target.
                            size={ICON_SIZE.md}
                            color={active ? theme.colors.text.primary : theme.colors.text.secondary}
                        />{active ? <View style={styles.marker} /> : null}</View>}
                    />
                );
            })}
        </ScrollView>
    );
}
