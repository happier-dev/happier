import * as React from 'react';
import type { WorkBoardArtifactSummaryV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';
import type { WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { StatusPill } from '@/components/ui/status/StatusPill';
import { WORK_STATUS_PILL_VARIANT } from '@/components/work/status/resolveWorkStatusTone';

import { describeBoardNeedYouCount } from './model/boardCards';
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
    const { needYou: count, undetermined } = useBoardLiveSummary(props.board);
    if (count === null || count === 0) return null;
    // Unresolved candidates make the proven count a floor: "3+", never an exhaustive "3".
    const atLeast = undetermined !== null && undetermined.count > 0;
    return (
        <StatusPill
            testID={`pinned-board:${props.board.id}:need-you`}
            variant={WORK_STATUS_PILL_VARIANT.attention}
            label={atLeast ? `${count}+` : String(count)}
            hideDot
            labelNumberOfLines={1}
            accessibilityLabel={describeBoardNeedYouCount(count, undetermined)}
        />
    );
});
