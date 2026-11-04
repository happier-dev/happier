import * as React from 'react';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { SurfaceStateCard, type SurfaceStateSize } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { useWorkBoardReadState, useWorkBoardSummaries } from './model/useWorkBoards';

/**
 * A failed read is never an empty Board collection; last-known Boards remain visible with Retry.
 * Each read is said once: the column says the index's state wherever it stands beside the page, so the
 * page then speaks only for its own Board, by name. Content already on screen (a Board, the column's
 * rows) re-reads quietly and speaks only when that re-read fails.
 */
export function BoardReadState(props: Readonly<{ size?: SurfaceStateSize; retained?: boolean; boardId?: string; place?: 'column' | 'page' }>) {
    const columnSaysIndex = useAppShellColumn().columnVisible && props.place !== 'column';
    const index = useWorkBoardReadState();
    const state = useWorkBoardReadState(props.boardId);
    const boardName = useWorkBoardSummaries().find(board => board.id === props.boardId)?.name;
    if (state.status === 'ready') return null;
    if (columnSaysIndex && index.status !== 'ready') return null;
    if (props.retained && state.status === 'loading') return null;
    const name = index.status === 'ready' && boardName ? boardName : t('boards.title');
    // Shown content is open already: a failed re-read says the content is last-known, never "couldn't open".
    const title = state.status === 'loading' ? t('surfaceState.opening', { name })
        : props.retained ? t('surfaceState.couldNotUpdate') : t('surfaceState.couldNotOpen', { name });
    const action = state.status === 'error' ? { label: t('surfaceState.tryAgain'), onPress: state.retry } : undefined;
    if (props.retained) return <SurfaceFreshnessLine testID="boards-read-stale" reason={title}
        busy={state.status === 'loading'} tone={state.status === 'error' ? 'warning' : 'neutral'} action={action} />;
    return <SurfaceStateCard testID="boards-read-state" kind={state.status === 'loading' ? 'loading' : 'error'}
        size={props.size} title={title} diagnosticCode={state.errorCode} action={action}
        accessibilitySemantics={state.status === 'error' ? 'alert' : 'status'} />;
}
