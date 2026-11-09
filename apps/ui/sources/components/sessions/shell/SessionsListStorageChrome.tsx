import * as React from 'react';
import type { PlaceableAppShellColumnId } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { ColumnDestinationRows } from '@/components/appShell/destinations/ColumnDestinationRows';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { BoardsInboxBoundary } from '@/components/boards/BoardsInboxBoundary';
import { usePinnedBoardRows } from '@/components/boards/usePinnedBoardRows';

export type SessionsListStorageChromeProps = Readonly<{
    /** The column these rows stand in. */
    column: PlaceableAppShellColumnId;
}>;

export const SessionsListStorageChrome = React.memo((props: SessionsListStorageChromeProps) => {
    const scope = captureActiveServerAccountScopeLifetime()?.scope ?? null;
    const universalSearchScope = scope ? {
        accountId: scope.accountId,
        serverId: scope.serverId,
        sessionId: null,
        machineId: null,
        rootPath: null,
    } : undefined;
    // Boards pinned to the Sessions list lead the column (INT §5.1, lab `boards-B6`); their counts share
    // one Inbox model, mounted only while a pinned board shows Needs you.
    const pinned = usePinnedBoardRows(props.column === 'sessions');
    return (
        <BoardsInboxBoundary boards={pinned.boards}>
            <ColumnDestinationRows
                column={props.column}
                universalSearchScope={universalSearchScope}
                leadingRows={pinned.rows}
            />
        </BoardsInboxBoundary>
    );
});
