import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmLogEntry } from '@happier-dev/protocol';
import { t } from '@/text';

import {
    SCM_HISTORY_INITIAL_VISIBLE_COUNT,
    SCM_HISTORY_LOAD_MORE_VISIBLE_STEP,
} from '@/scm/history/historyPresentation';
import { SourceControlOperationsHistoryLoadMoreButton } from './SourceControlOperationsHistoryLoadMoreButton';
import { SourceControlOperationsHistoryTimelineRow } from './SourceControlOperationsHistoryTimelineRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

type SourceControlOperationsHistorySectionProps = Readonly<{
    theme: any;
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

    const firstSha = historyEntries.at(0)?.sha ?? null;
    const lastFirstShaRef = React.useRef<string | null>(firstSha);
    React.useEffect(() => {
        // Reset when the list is replaced (e.g., refresh/reset pagination).
        if (lastFirstShaRef.current !== firstSha) {
            lastFirstShaRef.current = firstSha;
            setVisibleCount(SCM_HISTORY_INITIAL_VISIBLE_COUNT);
        }
    }, [firstSha]);

    if (historyLoading && historyEntries.length === 0) {
        return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
    }

    if (historyEntries.length === 0) {
        return (
            <Text style={{ color: theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
                {t('files.operationsHistory.noCommitsAvailable')}
            </Text>
        );
    }

    return (
        <View>
            <Text
                style={{
                    fontSize: 12,
                    color: theme.colors.text.secondary,
                    marginBottom: 6,
                    ...Typography.default('semiBold'),
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
