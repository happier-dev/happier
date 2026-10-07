import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkBoardV1 } from '@happier-dev/protocol';

import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionList, CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { BoardsInboxBoundary } from './BoardsInboxBoundary';
import { BOARDS_ROUTE, createBoardRoute, readOpenBoardId } from './boardsRoutes';
import { describeBoardSummaryLine, hasWorkBoardContent } from './model/boardCards';
import { useBoardLiveSummary } from './model/useBoardContent';
import { useDispatchWorkBoardIntent, useWorkBoardSaveState, useWorkBoards } from './model/useWorkBoards';
import { resolveCollectionSaveFailure } from './model/boardSaveFailure';
import { BoardSaveFailureLine } from './BoardSaveFailureLine';
import { BoardReadState } from './BoardReadState';

/**
 * The Boards destination's column (lab `boards-B1`): your boards, the open one selected, with one live
 * line each — who needs you and how many items it holds ("3 need you · 9 items"); search finds a board
 * by name, and the last row makes a new board. Only the open destination's column is mounted. A board with no source reads
 * nothing; the others read their own membership/status summaries, sharing one Inbox model only while one of them shows
 * Needs you.
 */

/** A board's row while it has a source: its live line, with the collection's trouble dot while it needs you. */
const LiveBoardRow = React.memo(function LiveBoardRow(props: Readonly<{ board: WorkBoardV1; selected: boolean; onPress: () => void }>) {
    const summary = useBoardLiveSummary(props.board);
    const line = describeBoardSummaryLine(summary);
    return (
        <CollectionNavigationRow
            testID={`boards-column:board:${props.board.id}`}
            href={createBoardRoute(props.board.id)}
            title={props.board.name}
            subtitle={line.text}
            subtitleLeading={line.needYou > 0
                ? <View testID={`boards-column:board:${props.board.id}:need-you`} style={collectionListStyles.troubleDot} />
                : undefined}
            icon={<Icon name="squares-four" />}
            selected={props.selected}
            onPress={props.onPress}
        />
    );
});

const BoardRow = React.memo(function BoardRow(props: Readonly<{ board: WorkBoardV1; selected: boolean }>) {
    const router = useRouter();
    const { board } = props;
    const onPress = React.useCallback(() => router.push(createBoardRoute(board.id) as never), [board.id, router]);
    if (hasWorkBoardContent(board)) return <LiveBoardRow board={board} selected={props.selected} onPress={onPress} />;
    return (
        <CollectionNavigationRow
            testID={`boards-column:board:${board.id}`}
            href={createBoardRoute(board.id)}
            title={board.name}
            subtitle={`${t('boards.meta.handPicked')} · ${t('boards.meta.empty')}`}
            icon={<Icon name="squares-four" />}
            selected={props.selected}
            onPress={onPress}
        />
    );
});

/** Creates a board and opens it. */
export function useCreateBoard(): () => void {
    const router = useRouter();
    const dispatch = useDispatchWorkBoardIntent();
    return React.useCallback(() => {
        const id = randomUUID();
        void dispatch({ kind: 'create', board: { id, name: t('boards.defaultName') } });
        router.push(createBoardRoute(id) as never);
    }, [dispatch, router]);
}

export const BoardsColumn = React.memo(function BoardsColumn(props: Readonly<{
    /** `page`: the column is the destination's first screen (a phone, or a collapsed column). */
    surface?: 'plane' | 'page';
}>) {
    const pathname = usePathname();
    const boards = useWorkBoards().boards;
    const [query, setQuery] = React.useState('');
    const needle = query.trim().toLowerCase();
    const matchingBoards = needle ? boards.filter(board => board.name.toLowerCase().includes(needle)) : boards;
    const createBoard = useCreateBoard();
    const openId = readOpenBoardId(pathname) ?? (pathname === BOARDS_ROUTE ? boards[0]?.id ?? null : null);
    // A refused save for a board that is not open (a delete the person was sent back from) is said here;
    // the open board says its own.
    const failure = resolveCollectionSaveFailure(useWorkBoardSaveState(), openId);
    return (
        <View testID="boards-column" style={styles.column}>
            {failure ? (
                <View style={styles.failure}>
                    <BoardSaveFailureLine testID="boards-column:save-failed" failure={failure} />
                </View>
            ) : null}
            <CollectionList
                testID="boards-column:list"
                surface={props.surface ?? 'plane'}
                title={t('boards.title')}
                search={{ value: query, onChangeText: setQuery, placeholder: t('common.search'), testID: 'boards-column:search' }}
            >
                <BoardReadState size="line" retained={boards.length > 0} />
                {/* The board rows' live lines share one Inbox model; the list itself never remounts for it. */}
                <BoardsInboxBoundary boards={matchingBoards}>
                    {matchingBoards.map((board) => <BoardRow key={board.id} board={board} selected={openId === board.id} />)}
                </BoardsInboxBoundary>
                <CollectionNavigationRow
                    testID="boards-column:new-row"
                    title={t('boards.newBoard')}
                    icon={<Icon name="plus" />}
                    selected={false}
                    onPress={createBoard}
                />
            </CollectionList>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    column: {
        flex: 1,
        minHeight: 0,
    },
    failure: {
        paddingHorizontal: theme.margins.md,
        paddingTop: theme.margins.sm,
    },
}));
