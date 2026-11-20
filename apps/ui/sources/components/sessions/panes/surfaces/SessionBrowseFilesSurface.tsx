import * as React from 'react';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionPaneScopeId } from '../sessionPaneScopeId';

import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';

export const SessionBrowseFilesSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId?: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
}>) => {
    const pane = useAppPaneScope(props.scopeId ?? resolveSessionPaneScopeId(props.sessionId));
    const files = pane.scopeState?.right.tabState.files as {
        revealRequest?: Readonly<{ path: string }>;
        viewRequest?: Readonly<{ view: 'session' }>;
    } | undefined;
    const filesRef = React.useRef(files);
    filesRef.current = files;
    // The request is one-shot: clear it once applied so a later plain open of Files is not hijacked.
    const clearViewRequest = React.useCallback(() => {
        const { viewRequest: _applied, ...rest } = filesRef.current ?? {};
        pane.setRightTabState('files', rest);
    }, [pane.setRightTabState]);
    return (
    <SessionRepositoryTreeBrowserView
        sessionId={props.sessionId}
        onOpenFile={props.onOpenFile}
        onOpenFilePinned={props.onOpenFilePinned}
        revealRequest={files?.revealRequest}
        viewRequest={files?.viewRequest}
        onViewRequestHandled={clearViewRequest}
        density="panel"
    />
);
});
