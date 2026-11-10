import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { WorkBoardArtifactSummaryV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';

import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CollectionList, CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { BoardsInboxBoundary } from './BoardsInboxBoundary';
import { BOARDS_ROUTE, createBoardRoute, readOpenBoardId } from './boardsRoutes';
import { describeBoardSummaryLine, hasWorkBoardContent } from './model/boardCards';
import { useBoardLiveSummary } from './model/useBoardContent';
import { useDispatchWorkBoardIntent, useWorkBoardReadState, useWorkBoardSaveState, useWorkBoardSummaries, useWorkBoards } from './model/useWorkBoards';
import { resolveCollectionSaveFailure } from './model/boardSaveFailure';
import { BoardSaveFailureLine } from './BoardSaveFailureLine';
import { BoardReadState } from './BoardReadState';

/**
 * The Boards destination's column (lab `boards-B1`): your boards, the open one selected, with one live
 * line each — who needs you and how many items it holds ("3 need you · 9 items"); search finds a board
 * by name behind its magnifier, and the title row's "+" (the phone bar's too) makes a new board. Only the open
 * destination's column is mounted. A board with no source reads nothing; the others read their own membership/status summaries, sharing one Inbox work projection only while one of them shows
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
            selected={props.selected}
            onPress={props.onPress}
        />
    );
});

const BoardRow = React.memo(function BoardRow(props: Readonly<{ summary: WorkBoardArtifactSummaryV1; board: WorkBoardV1 | null; selected: boolean }>) {
    const router = useRouter();
    const { board, summary } = props;
    const onPress = React.useCallback(() => router.push(createBoardRoute(summary.id) as never), [summary.id, router]);
    if (board && hasWorkBoardContent(board)) return <LiveBoardRow board={board} selected={props.selected} onPress={onPress} />;
    return (
        <CollectionNavigationRow
            testID={`boards-column:board:${summary.id}`}
            href={createBoardRoute(summary.id)}
            title={summary.name}
            subtitle={board ? `${t('boards.meta.handPicked')} · ${t('boards.meta.empty')}` : undefined}
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

/**
 * Boards with no board yet: the invitation to make one. Said once, wherever the destination's first screen is:
 * the page beside the column, or the column itself when it is the page (a phone).
 */
export function BoardsEmptyState(props: Readonly<{ testID: string }>) {
    const createBoard = useCreateBoard();
    return (
        <EmptyState
            testID={props.testID}
            layout="page"
            scene="emptyBoard"
            title={t('boards.index.title')}
            subtitle={t('boards.index.body')}
            primaryAction={{ label: t('boards.newBoard'), onPress: createBoard, testID: `${props.testID}:new` }}
        />
    );
}

const BOARDS_PHONE_PAGE = Object.freeze({ backTestID: 'boards-column:back' });

export const BoardsColumn = React.memo(function BoardsColumn(props: Readonly<{
    /** `page`: the column is the destination's first screen (a phone, or a collapsed column). */
    surface?: 'plane' | 'page';
}>) {
    const pathname = usePathname();
    const bodies = useWorkBoards().boards;
    const boards = useWorkBoardSummaries();
    const [query, setQuery] = React.useState('');
    const needle = query.trim().toLowerCase();
    const matchingBoards = needle ? boards.filter(board => board.name.toLowerCase().includes(needle)) : boards;
    const createBoard = useCreateBoard();
    // Beside a page, /boards shows the first board, so its row is selected; as the page itself (a phone main
    // screen) nothing is open yet, so nothing is selected.
    const openId = readOpenBoardId(pathname) ?? (pathname === BOARDS_ROUTE && props.surface !== 'page' ? boards[0]?.id ?? null : null);
    // A refused save for a board that is not open (a delete the person was sent back from) is said here;
    // the open board says its own.
    const failure = resolveCollectionSaveFailure(useWorkBoardSaveState(), openId);
    const create = React.useMemo(() => ({ label: t('boards.newBoard'), testID: 'boards-column:new', onPress: createBoard }), [createBoard]);
    const empty = useWorkBoardReadState().status === 'ready' && boards.length === 0;
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
                phonePage={props.surface === 'page' ? BOARDS_PHONE_PAGE : null}
                title={t('boards.title')}
                create={create}
                search={{ value: query, onChangeText: setQuery, placeholder: t('common.search'), testID: 'boards-column:search', collapsible: true }}
            >
                <BoardReadState place="column" size="line" retained={boards.length > 0} />
                {/* The board rows share Inbox membership without mounting its detail rows. */}
                <BoardsInboxBoundary boards={matchingBoards}>
                    {matchingBoards.map((summary) => <BoardRow key={summary.id} summary={summary}
                        board={bodies.find(board => board.id === summary.id) ?? null} selected={openId === summary.id} />)}
                </BoardsInboxBoundary>
                {/* Beside the page, the page says it (BoardsIndex); as the page itself, the column does. */}
                {empty && props.surface === 'page' ? <BoardsEmptyState testID="boards-column:empty" /> : null}
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
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s8,
    },
}));
