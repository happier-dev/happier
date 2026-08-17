import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';

export type ConnectedServiceDetailSegment = 'accounts' | 'pools';

export type ConnectedServiceSegmentedShellProps = Readonly<{
    activeSegment: ConnectedServiceDetailSegment;
    onSelectSegment: (segment: ConnectedServiceDetailSegment) => void;
    /**
     * Whether the Pools segment is reachable. Fail-closed: when false the tab bar
     * is hidden entirely and only the Accounts content renders, regardless of the
     * requested `activeSegment`.
     */
    poolsAvailable: boolean;
    /** Account list and its account-scoped actions. */
    accountsContent: React.ReactNode;
    /** Qualified group content. Only rendered when {@link poolsAvailable}. */
    poolsContent: React.ReactNode;
}>;

/**
 * Segmented `Accounts | Pools` shell for a qualified Connected Account service.
 * "Pools" is the user-facing name; wire symbols stay `group`.
 */
export const ConnectedServiceSegmentedShell = React.memo(function ConnectedServiceSegmentedShell(
    props: ConnectedServiceSegmentedShellProps,
) {
    const { poolsAvailable } = props;
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const tabBarMaxWidthStyle = useLayoutMaxWidthStyle();
    // Fail-closed: an unavailable Pools segment can never be the active tab.
    const activeSegment: ConnectedServiceDetailSegment = poolsAvailable ? props.activeSegment : 'accounts';

    const tabs = React.useMemo<ReadonlyArray<SegmentedTab<ConnectedServiceDetailSegment>>>(() => [
        { id: 'accounts', label: t('connectedServices.detail.segments.accounts') },
        { id: 'pools', label: t('connectedServices.detail.segments.pools') },
    ], []);

    return (
        <View testID="connected-services-detail-shell">
            {poolsAvailable ? (
                <View style={styles.tabBarWrapper}>
                    <View style={[styles.tabBar, tabBarMaxWidthStyle]}>
                        <SegmentedTabBar
                            tabs={tabs}
                            activeTabId={activeSegment}
                            onSelectTab={props.onSelectSegment}
                            testIDPrefix="connected-services-detail-shell:segment"
                        />
                    </View>
                </View>
            ) : null}

            {activeSegment === 'pools' && poolsAvailable ? props.poolsContent : props.accountsContent}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    tabBarWrapper: {
        alignItems: 'center',
    },
    tabBar: {
        width: '100%',
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: 8,
    },
}));
