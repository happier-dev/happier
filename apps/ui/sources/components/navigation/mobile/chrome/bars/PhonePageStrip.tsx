import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';

import type { CockpitTabBarTabDefinition } from './CockpitTabBar';

/**
 * A cockpit phone's top page strip (plan T U1): the shared page-tab bar in a sideways scroller that
 * brings the selected page into view. Session and Project draw their pinned pages here, with tools and
 * the single More left in the bottom bar. Selection and placement belong to the caller's owners.
 */
export function PhonePageStripView(props: Readonly<{
    tabs: readonly CockpitTabBarTabDefinition<string>[];
    activeId: string;
    onSelect: (id: string) => void;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'session-phone-page-strip';
    const scrollRef = React.useRef<ScrollView>(null);
    const tabFrames = React.useRef(new Map<string, Readonly<{ x: number; width: number }>>());
    const viewportWidth = React.useRef(0);
    // The selected tab scrolls into view when it changes (a tool or More can select a page off-screen).
    React.useEffect(() => {
        const frame = tabFrames.current.get(props.activeId);
        if (!frame || !scrollRef.current) return;
        scrollRef.current.scrollTo({ x: Math.max(0, frame.x + frame.width / 2 - viewportWidth.current / 2), animated: true });
    }, [props.activeId]);
    const glyphColor = theme.colors.text.secondary;
    const tabs = props.tabs.map(tab => ({ id: tab.id, label: tab.label, disabled: tab.disabled,
        ...(tab.unavailableReason ? { unavailableReason: tab.unavailableReason } : {}),
        icon: typeof tab.icon === 'string' ? <Icon name={tab.icon} size={ICON_SIZE.sm} color={glyphColor} />
            : tab.icon.render({ active: tab.id === props.activeId, size: ICON_SIZE.sm, tintColor: glyphColor }) }));
    // A tool selected from the bottom bar leaves no page selected in the strip.
    const active = props.tabs.some(tab => tab.id === props.activeId) ? props.activeId : '';
    return <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false} testID={testID}
        style={[styles.strip, { borderBottomColor: theme.colors.border.subtle }]}
        contentContainerStyle={styles.content}
        onLayout={event => { viewportWidth.current = event.nativeEvent.layout.width; }}>
        <SegmentedTabBar
            presentation="plain"
            iconPlacement="leading"
            segmentSizing="content"
            tabs={tabs}
            activeTabId={active}
            onSelectTab={props.onSelect}
            wrapTab={(id, node) => <View onLayout={event => { tabFrames.current.set(id, event.nativeEvent.layout); }}>{node}</View>}
            accessibilityLabel={t('navigationPlacement.pageTabsTitle')}
            testIDPrefix={testID}
        />
    </ScrollView>;
}

const styles = StyleSheet.create(theme => ({
    strip: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth },
    content: { paddingHorizontal: theme.space.s12, paddingBottom: theme.space.s4 },
}));
