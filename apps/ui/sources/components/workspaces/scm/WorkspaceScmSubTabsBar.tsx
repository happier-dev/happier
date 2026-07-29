import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';

export type GitSubTabId = 'commit' | 'update' | 'history';

export type WorkspaceScmSubTabsBarProps = Readonly<{
    tabs: ReadonlyArray<{ id: GitSubTabId; label: string }>;
    activeSubTabId: GitSubTabId;
    onSelectSubTab: (subTabId: GitSubTabId) => void;
    /** Trailing-colon convention, e.g. `project-rightpanel-git-subtab:` — unchanged for callers. */
    testIDPrefix?: string;
}>;

/**
 * This used to be a bespoke segmented control: its own bordered track, its own typography, and an
 * active state that was the INVERSE of the canonical one (active tab = inset fill on a base track,
 * where SegmentedTabBar uses a raised thumb on an inset track). Two controls that look like the same
 * thing but invert their own selection semantics is the kind of split-brain that makes a product
 * feel inconsistent without any single screen looking wrong — and this one is shared by the session
 * and project SCM panes, so it was wrong in two places at once.
 *
 * It also declared its `Tab` component inside the render body, giving it a fresh component identity
 * on every parent render and remounting all three tabs each time.
 *
 * It is now a thin arrangement over the canonical `SegmentedTabBar`. That control emits
 * `${prefix}:${id}` while this component's prop convention carries its own trailing colon, so the
 * colon is stripped before handing the prefix over and both consumers keep the exact testIDs they
 * already had.
 */

const DEFAULT_TEST_ID_PREFIX = 'session-rightpanel-git-subtab:';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
}));

export const WorkspaceScmSubTabsBar = React.memo((props: WorkspaceScmSubTabsBarProps) => {
    const styles = stylesheet;

    const rawPrefix = typeof props.testIDPrefix === 'string' && props.testIDPrefix.trim().length > 0
        ? props.testIDPrefix.trim()
        : DEFAULT_TEST_ID_PREFIX;
    const testIDPrefix = rawPrefix.endsWith(':') ? rawPrefix.slice(0, -1) : rawPrefix;

    const tabs = React.useMemo(
        (): ReadonlyArray<SegmentedTab<GitSubTabId>> =>
            props.tabs.map((tab) => ({ id: tab.id, label: tab.label })),
        [props.tabs],
    );

    return (
        <View style={styles.container}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={props.activeSubTabId}
                onSelectTab={props.onSelectSubTab}
                testIDPrefix={testIDPrefix}
            />
        </View>
    );
});
