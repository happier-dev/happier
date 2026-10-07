import * as React from 'react';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t } from '@/text';

import { BoardScreen } from './BoardScreen';
import { BoardReadState } from './BoardReadState';
import { BoardsColumn, useCreateBoard } from './BoardsColumn';
import { useWorkBoardReadState, useWorkBoards } from './model/useWorkBoards';

/**
 * `/boards`. Beside the column, main shows the first board (its row is selected); with no board yet,
 * the invitation to make one. Without the column — a phone, or a collapsed column — the column is the
 * destination's first screen.
 */
export const BoardsIndex = React.memo(function BoardsIndex() {
    const columnVisible = useAppShellColumn().columnVisible;
    const first = useWorkBoards().boards[0] ?? null;
    const read = useWorkBoardReadState();
    const createBoard = useCreateBoard();
    if (!columnVisible) return <BoardsColumn surface="page" />;
    if (first) return <BoardScreen boardId={first.id} />;
    if (read.status !== 'ready') return <BoardReadState />;
    return (
        <EmptyState
            testID="boards-index-empty"
            layout="page"
            scene="emptyBoard"
            title={t('boards.index.title')}
            subtitle={t('boards.index.body')}
            primaryAction={{ label: t('boards.newBoard'), onPress: createBoard }}
        />
    );
});
