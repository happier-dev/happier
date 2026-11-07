import * as React from 'react';
import type { WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { InboxWorkProjectionBoundary } from '@/hooks/inbox/useInboxWorkProjection';

/**
 * One Inbox work projection for a list of boards' live lines (the pinned rows in the Sessions column, the Boards
 * column), mounted only while one of those boards shows Needs you. A board without that section never
 * reads the Inbox, so a list of such boards mounts none.
 */
export function BoardsInboxBoundary(props: Readonly<{ boards: readonly Readonly<{ source: Pick<WorkBoardV1['source'], 'sections'> }>[]; children: React.ReactNode }>) {
    const needed = props.boards.some(board => board.source.sections?.includes('needs_you'));
    return <InboxWorkProjectionBoundary enabled={needed}>{props.children}</InboxWorkProjectionBoundary>;
}
