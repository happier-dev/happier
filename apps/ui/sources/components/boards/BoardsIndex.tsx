import * as React from 'react';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t } from '@/text';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { BoardScreen, FilteredBoardScreen } from './BoardScreen';
import { readFilteredBoardRoute } from './boardsRoutes';
import { BoardReadState } from './BoardReadState';
import { BoardsColumn, BoardsEmptyState } from './BoardsColumn';
import { useWorkBoardReadState, useWorkBoardSummaries } from './model/useWorkBoards';

/**
 * `/boards`. Beside the column, main shows the first board (its row is selected); with no board yet,
 * the invitation to make one. Without the column — a phone, or a collapsed column — the column is the
 * destination's first screen.
 */
export const BoardsIndex = React.memo(function BoardsIndex() {
    const params = useLocalSearchParams<{ filter?: string | string[] }>();
    if (params.filter !== undefined) {
        const filter = readFilteredBoardRoute(params.filter);
        return filter ? <FilteredBoardScreen filter={filter} /> : <EmptyState layout="page"
            title={t('boards.card.unavailable')} subtitle={t('boards.card.unavailableBody')} />;
    }
    return <SavedBoardsIndex />;
});

const SavedBoardsIndex = React.memo(function SavedBoardsIndex() {
    const columnVisible = useAppShellColumn().columnVisible;
    const first = useWorkBoardSummaries()[0] ?? null;
    const read = useWorkBoardReadState();
    if (!columnVisible) return <BoardsColumn surface="page" />;
    if (first) return <BoardScreen boardId={first.id} />;
    if (read.status !== 'ready') return <BoardReadState />;
    return <BoardsEmptyState testID="boards-index-empty" />;
});
