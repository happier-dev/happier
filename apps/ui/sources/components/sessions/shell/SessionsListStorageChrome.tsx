import * as React from 'react';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { SessionsListActionRows } from './SessionsListActionRows';

export type SessionsListStorageChromeProps = Readonly<{
    externalSessionsEnabled: boolean;
    storageKind: SessionListStorageFilter;
}>;

export const SessionsListStorageChrome = React.memo((props: SessionsListStorageChromeProps) => {
    return <SessionsListActionRows externalSessionsEnabled={props.externalSessionsEnabled} />;
});
