import * as React from 'react';

import { useWorkspaceFileOpener, type WorkspaceFileOpenOptions } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { readPressFocusReturnTarget } from '@/keyboard/focusReturn';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { isAbsoluteLocalPath, normalizeRelativeLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { resolveWorkspaceFileReference } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import { useOptionalSessionTranscriptSource } from './source/SessionTranscriptSourceContext';
import type { StructuredMessageRendererParams } from './structured/structuredMessageRegistry';

/** One file-link boundary for text, structured anchors, attachments and tool evidence. */
export function useTranscriptFileLinks(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    workspacePath: string | null | undefined;
    canOpenFiles: boolean;
    routeMessageId?: string | null;
    seq?: number | null;
}>) {
    const source = useOptionalSessionTranscriptSource();
    const { open, canOpen } = useWorkspaceFileOpener();
    const enabled = params.canOpenFiles && source?.navigate != null && canOpen;
    const serverId = params.serverId ?? source?.serverId;
    const sessionAddress = React.useMemo(() => normalizeSessionAddress(serverId, params.sessionId), [serverId, params.sessionId]);
    const openPath = React.useCallback((path: string, options?: WorkspaceFileOpenOptions & Readonly<{ event?: unknown }>): boolean => {
        if (!enabled) return false;
        const rootPath = options?.rootPath ?? params.workspacePath;
        const filePath = isAbsoluteLocalPath(path.replace(/\\/g, '/'))
            ? rootPath ? resolvePathRelativeToRoot({ path, root: rootPath, preservePathSpelling: true }) : null
            : normalizeRelativeLocalPath(path);
        if (filePath === null || !isSafeWorkspaceRelativePath(filePath)) return false;
        const { event, ...openOptions } = options ?? {};
        fireAndForget(open({
            kind: 'session', sessionId: params.sessionId,
            ...(serverId ? { serverId } : {}), path: filePath,
        }, {
            view: 'view',
            ...openOptions,
            origin: {
                focusReturnRef: { current: readPressFocusReturnTarget(event) },
                ...(sessionAddress && (params.routeMessageId != null || params.seq != null) ? {
                    transcript: { sessionAddress, routeMessageId: params.routeMessageId, seq: params.seq, filePath },
                } : {}),
            },
        }), { tag: 'useTranscriptFileLinks.openPath' });
        return true;
    }, [enabled, open, params.routeMessageId, params.seq, serverId, params.sessionId, params.workspacePath, sessionAddress]);
    const onMarkdownLinkPress = React.useCallback((url: string) => {
        const resolved = resolveWorkspaceFileReference({ url, workspacePath: params.workspacePath });
        return resolved ? openPath(resolved.filePath, resolved.anchor ? { anchor: resolved.anchor, anchorSource: 'file' } : undefined) : false;
    }, [openPath, params.workspacePath]);
    const jumpToAnchor = React.useCallback<NonNullable<StructuredMessageRendererParams['onJumpToAnchor']>>((target) => {
        openPath(target.filePath, { anchor: target.anchor, anchorSource: target.source, view: target.source === 'diff' ? 'changes' : 'view' });
    }, [openPath]);
    return { canOpen: enabled, onMarkdownLinkPress, openPath, onJumpToAnchor: enabled ? jumpToAnchor : undefined };
}
