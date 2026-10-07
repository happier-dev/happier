import * as React from 'react';
import type { WorkBoardArtifactSummaryV1, WorkBoardV1 } from '@happier-dev/protocol';

import { StatusPill } from '@/components/ui/status/StatusPill';
import { WORK_STATUS_PILL_VARIANT } from '@/components/work/status/resolveWorkStatusTone';
import { t } from '@/text';

import { useBoardLiveSummary } from './model/useBoardContent';
import { useWorkBoard } from './model/useWorkBoards';

/**
 * A pinned board's needs-you count in the Sessions column (lab `boards-B6`): the same membership and
 * status facts as the open board, without constructing its cards, as the column's own badge (the
 * plugin destinations' `StatusPill`). Mounted only for boards the person pinned; healthy boards show
 * nothing. The pinned rows share one Inbox model (`BoardsInboxBoundary` around the column's rows).
 */
export const PinnedBoardNeedsYouCount = React.memo(function PinnedBoardNeedsYouCount(props: Readonly<{ board: WorkBoardArtifactSummaryV1 }>) {
    const board = useWorkBoard(props.board.id);
    return board ? <PinnedBoardLiveCount board={board} /> : null;
});

const PinnedBoardLiveCount = React.memo(function PinnedBoardLiveCount(props: Readonly<{ board: WorkBoardV1 }>) {
    const { needYou: count } = useBoardLiveSummary(props.board);
    if (count === 0) return null;
    return (
        <StatusPill
            testID={`pinned-board:${props.board.id}:need-you`}
            variant={WORK_STATUS_PILL_VARIANT.attention}
            label={String(count)}
            hideDot
            labelNumberOfLines={1}
            accessibilityLabel={t('boards.meta.needYou', { count })}
        />
    );
});
