import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmLogEntry } from '@happier-dev/protocol/scm';
import { t } from '@/text';

import {
    SCM_HISTORY_INITIAL_VISIBLE_COUNT,
    SCM_HISTORY_LOAD_MORE_VISIBLE_STEP,
} from '@/scm/history/historyPresentation';
import { SourceControlOperationsHistoryLoadMoreButton } from './SourceControlOperationsHistoryLoadMoreButton';
import { SourceControlOperationsHistoryTimelineRow } from './SourceControlOperationsHistoryTimelineRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

type SourceControlOperationsHistorySectionProps = Readonly<{
    theme: any;
    historyIdentity: string;
    onCommitLayout?: (sha: string, y: number, height: number) => void;
    historyLoading: boolean;
    historyEntries: ScmLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
}>;

export function SourceControlOperationsHistorySection(props: SourceControlOperationsHistorySectionProps) {
    const { theme, historyLoading, historyEntries, historyHasMore, onLoadMoreHistory, onOpenCommit } = props;
    const [visibleCount, setVisibleCount] = React.useState(SCM_HISTORY_INITIAL_VISIBLE_COUNT);
    const renderedVisibleCount = Math.min(historyEntries.length, visibleCount);

    const [historyContext, setHistoryContext] = React.useState({
        identity: props.historyIdentity,
        entries: historyEntries,
    });
    if (historyContext.identity !== props.historyIdentity) {
        setHistoryContext({ identity: props.historyIdentity, entries: historyEntries });
        setVisibleCount(SCM_HISTORY_INITIAL_VISIBLE_COUNT);
    } else if (historyContext.entries !== historyEntries) {
        // Keep the oldest displayed commit visible when new commits arrive above it.
        const lastVisibleSha = historyContext.entries[Math.min(visibleCount, historyContext.entries.length) - 1]?.sha;
        const nextIndex = historyEntries.findIndex((entry) => entry.sha === lastVisibleSha);
        setHistoryContext({ identity: props.historyIdentity, entries: historyEntries });
        if (visibleCount > SCM_HISTORY_INITIAL_VISIBLE_COUNT && nextIndex >= visibleCount) setVisibleCount(nextIndex + 1);
    }

    if (historyLoading && historyEntries.length === 0) {
        return <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />;
    }

    if (historyEntries.length === 0) {
        return <SurfaceStateCard size="line" kind="empty" title={t('files.operationsHistory.noCommitsAvailable')} />;
    }

    return (
        <View>
            <Text
                style={{
                    ...Typography.variant('meta', 'semiBold'),
                    color: theme.colors.text.secondary,
                    marginBottom: theme.space.s6,
                }}
            >
                {t('files.operationsHistory.recentCommits')}
            </Text>
            {historyEntries.slice(0, renderedVisibleCount).map((entry, index, visibleEntries) => (
                <SourceControlOperationsHistoryTimelineRow
                    key={entry.sha}
                    theme={theme}
                    entry={entry}
                    isHead={index === 0}
                    showTrailingLine={index < visibleEntries.length - 1 || historyHasMore}
                    onOpenCommit={onOpenCommit}
                    onCommitLayout={props.onCommitLayout}
                />
            ))}
            {(historyHasMore || visibleCount < historyEntries.length) && (
                <SourceControlOperationsHistoryLoadMoreButton
                    theme={theme}
                    historyLoading={historyLoading}
                    onPress={() => {
                        const nextVisibleCount = visibleCount + SCM_HISTORY_LOAD_MORE_VISIBLE_STEP;
                        setVisibleCount(nextVisibleCount);
                        if (historyHasMore && nextVisibleCount > historyEntries.length) {
                            onLoadMoreHistory();
                        }
                    }}
                />
            )}
        </View>
    );
}
