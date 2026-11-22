import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { useSetting } from '@/sync/domains/state/storage';

export type SessionListStorageTabsBarProps = Readonly<{
    activeTabId: SessionStorageKind;
    onSelectTab: (tabId: SessionStorageKind) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 15,
        paddingTop: 10,
        paddingBottom: 10,
        backgroundColor: theme.colors.background.canvas,
    },
}));

export const SessionListStorageTabsBar = React.memo((props: SessionListStorageTabsBarProps) => {
    const styles = stylesheet;
    useUnistyles();
    useSetting('preferredLanguage');
    const tabs: ReadonlyArray<SegmentedTab<SessionStorageKind>> = [
        { id: 'persisted', label: t('sessionsList.storagePersistedTab') },
        { id: 'direct', label: t('sessionsList.storageDirectTab') },
    ];

    return (
        <View style={styles.container}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={props.activeTabId}
                onSelectTab={props.onSelectTab}
                testIDPrefix="sessions-list-storage-tab"
            />
        </View>
    );
});
