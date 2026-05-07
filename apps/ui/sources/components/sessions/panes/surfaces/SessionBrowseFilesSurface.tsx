import * as React from 'react';

import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';

export const SessionBrowseFilesSurface = React.memo((props: Readonly<{
    sessionId: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
}>) => (
    <SessionRepositoryTreeBrowserView
        sessionId={props.sessionId}
        onOpenFile={props.onOpenFile}
        onOpenFilePinned={props.onOpenFilePinned}
        density="panel"
    />
));
