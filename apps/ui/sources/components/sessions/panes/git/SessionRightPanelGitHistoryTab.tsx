import * as React from 'react';
import { ScrollView, View } from 'react-native';
import type { ScmLogEntry } from '@happier-dev/protocol';

import { SourceControlOperationsHistorySection } from '@/components/sessions/files/SourceControlOperationsHistorySection';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

export type SessionRightPanelGitHistoryTabProps = Readonly<{
    theme: any;
    historyLoading: boolean;
    historyEntries: ScmLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
}>;

export const SessionRightPanelGitHistoryTab = React.memo((props: SessionRightPanelGitHistoryTabProps) => {
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 12, paddingBottom: 16 }}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                scrollEventThrottle={16}
            >
                <SourceControlOperationsHistorySection
                    theme={props.theme}
                    historyLoading={props.historyLoading}
                    historyEntries={props.historyEntries}
                    historyHasMore={props.historyHasMore}
                    onLoadMoreHistory={props.onLoadMoreHistory}
                    onOpenCommit={props.onOpenCommit}
                />
            </ScrollView>
            <ScrollEdgeFades
                color={props.theme.colors.surface}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={props.theme.colors.textSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
