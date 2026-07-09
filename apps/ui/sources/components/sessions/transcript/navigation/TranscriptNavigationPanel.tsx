import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { TranscriptNavigationActionButton } from './TranscriptNavigationActionButton';
import { TranscriptNavigationEntryList } from './TranscriptNavigationEntryList';
import type {
    TranscriptNavigationDerivationMode,
    TranscriptNavigationEntry,
    TranscriptNavigationEntryPressHandler,
} from './transcriptNavigationTypes';

export type TranscriptNavigationPanelProps = Readonly<{
    sessionId: string;
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId: string | null;
    onEntryPress: TranscriptNavigationEntryPressHandler;
    onRequestClose?: () => void;
    testIDPrefix?: string;
}>;

const MODE_TABS: ReadonlyArray<SegmentedTab<TranscriptNavigationDerivationMode>> = [
    { id: 'all', label: t('session.transcriptNavigation.modeAll') },
    { id: 'pinned', label: t('session.transcriptNavigation.modePinned') },
];

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
    header: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    titleBlock: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    count: {
        color: theme.colors.text.secondary,
    },
    mode: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    empty: {
        paddingHorizontal: 18,
        paddingVertical: 18,
        gap: 4,
    },
    emptyTitle: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    emptyBody: {
        color: theme.colors.text.secondary,
    },
    emptyCaveat: {
        marginTop: 6,
        color: theme.colors.text.tertiary,
    },
}));

function defaultTestIDPrefix(prefix: string | undefined): string {
    return prefix && prefix.trim().length > 0 ? prefix.trim() : 'transcript-navigation';
}

function filterEntries(entries: readonly TranscriptNavigationEntry[], mode: TranscriptNavigationDerivationMode): TranscriptNavigationEntry[] {
    if (mode === 'pinned') {
        return entries.filter((entry) => entry.pinned);
    }
    return [...entries];
}

export const TranscriptNavigationPanel = React.memo((props: TranscriptNavigationPanelProps) => {
    const styles = stylesheet;
    const [mode, setMode] = React.useState<TranscriptNavigationDerivationMode>('all');
    const testIDPrefix = defaultTestIDPrefix(props.testIDPrefix);
    const entries = React.useMemo(() => filterEntries(props.entries, mode), [mode, props.entries]);
    const pinnedCount = React.useMemo(() => props.entries.filter((entry) => entry.pinned).length, [props.entries]);
    const countLabel = mode === 'pinned'
        ? t('session.transcriptNavigation.pinnedCount', { count: pinnedCount })
        : t('session.transcriptNavigation.entryCount', { count: props.entries.length });

    return (
        <View
            testID={`${testIDPrefix}-panel`}
            style={styles.container}
            accessibilityLabel={t('session.transcriptNavigation.title')}
        >
            <View style={styles.header}>
                <View style={styles.titleBlock}>
                    <Text numberOfLines={1} style={styles.title}>{t('session.transcriptNavigation.title')}</Text>
                    <Text numberOfLines={1} style={styles.count}>{countLabel}</Text>
                </View>
                {props.onRequestClose ? (
                    <TranscriptNavigationActionButton
                        testID={`${testIDPrefix}-close`}
                        iconName="x"
                        accessibilityLabel={t('common.close')}
                        onPress={props.onRequestClose}
                    />
                ) : null}
            </View>
            <View style={styles.mode}>
                <SegmentedTabBar
                    tabs={MODE_TABS}
                    activeTabId={mode}
                    onSelectTab={setMode}
                    testIDPrefix={`${testIDPrefix}-mode`}
                    compact
                />
            </View>
            <View style={styles.body}>
                {entries.length > 0 ? (
                    <TranscriptNavigationEntryList
                        entries={entries}
                        activeEntryId={props.activeEntryId}
                        onEntryPress={props.onEntryPress}
                        onRequestClose={props.onRequestClose}
                        testIDPrefix={testIDPrefix}
                    />
                ) : (
                    <View
                        testID={mode === 'pinned' ? `${testIDPrefix}-empty-pinned` : `${testIDPrefix}-empty`}
                        style={styles.empty}
                    >
                        <Text style={styles.emptyTitle}>
                            {mode === 'pinned'
                                ? t('session.transcriptNavigation.emptyPinnedTitle')
                                : t('session.transcriptNavigation.emptyAllTitle')}
                        </Text>
                        <Text style={styles.emptyBody}>
                            {mode === 'pinned'
                                ? t('session.transcriptNavigation.emptyPinnedBody')
                                : t('session.transcriptNavigation.emptyAllBody')}
                        </Text>
                        {mode === 'pinned' ? (
                            <>
                                <Text style={styles.emptyBody}>
                                    {t('session.transcriptNavigation.emptyPinnedHint')}
                                </Text>
                                <Text style={styles.emptyCaveat}>
                                    {t('session.transcriptNavigation.emptyPinnedPrivacy')}
                                </Text>
                            </>
                        ) : null}
                    </View>
                )}
            </View>
        </View>
    );
});
