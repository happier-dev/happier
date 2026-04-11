import * as React from 'react';

import { SessionRightPanelGitView } from '@/components/sessions/panes/git/SessionRightPanelGitView';

export const SessionGitSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenFile?: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    onOpenCommit?: (sha: string) => void;
}>) => {
    return (
        <SessionRightPanelGitView
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
            onOpenCommit={props.onOpenCommit}
        />
    );
});
