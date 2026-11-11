import * as React from 'react';

import { useWorkspaceFileOpener, type WorkspaceFileOpenOptions } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { useOpenResource } from '@/utils/url/openResource';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { readPressFocusReturnTarget } from '@/keyboard/focusReturn';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { isAbsoluteLocalPath, normalizeAbsoluteLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { splitInputIntoDirectoryAndLeaf } from '@/utils/path/browseSegments';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { resolveWorkspaceFilePath, resolveWorkspaceFileReference } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
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
    const { openResourceUrl } = useOpenResource({ sessionId: params.sessionId, serverId: serverId ?? undefined, chatLink: true });
    const sessionAddress = React.useMemo(() => normalizeSessionAddress(serverId, params.sessionId), [serverId, params.sessionId]);
    const openPath = React.useCallback((path: string, options?: WorkspaceFileOpenOptions & Readonly<{ event?: unknown }>): boolean => {
        if (!enabled) return false;
        const candidate = resolveWorkspaceFilePath({ path, workspacePath: options?.rootPath ?? params.workspacePath,
            allowOutsideWorkspace: true });
        if (candidate === null) return false;
        let filePath = candidate;
        let rootPath = options?.rootPath;
        if (isAbsoluteLocalPath(candidate)) {
            const target = resolveWorkspaceTargetForSession(sessionAddress ?? params.sessionId);
            const machineRoot = rootPath ?? target?.rootPath;
            if (!machineRoot) return false;
            const mapped = resolveMachineAbsolutePath({ rootPath: machineRoot,
                ...(!rootPath && target?.agentRootPath ? { agentRootPath: target.agentRootPath } : {}),
                requestPath: candidate, pathKind: 'workspace_entry' });
            const absolute = normalizeAbsoluteLocalPath(mapped.replace(/\\/g, '/'));
            const relative = resolvePathRelativeToRoot({ path: absolute, root: machineRoot, preservePathSpelling: true });
            if (relative !== null && isSafeWorkspaceRelativePath(relative)) {
                filePath = relative;
            } else {
                const split = splitInputIntoDirectoryAndLeaf(absolute);
                rootPath = split.dir;
                filePath = split.leaf;
            }
        }
        if (!isSafeWorkspaceRelativePath(filePath)) return false;
        const { event, ...openOptions } = options ?? {};
        const anchor = openOptions.anchor;
        if (anchor?.kind === 'line' || anchor?.kind === 'range') openOptions.anchor = { ...anchor, filePath };
        if (rootPath) openOptions.rootPath = rootPath;
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
        const resolved = resolveWorkspaceFileReference({ url, workspacePath: params.workspacePath, allowOutsideWorkspace: true });
        if (resolved) return openPath(resolved.filePath, resolved.anchor ? { anchor: resolved.anchor, anchorSource: 'file' } : undefined);
        fireAndForget(openResourceUrl(url), { tag: 'useTranscriptFileLinks.openResourceUrl' });
        return true;
    }, [openPath, openResourceUrl, params.workspacePath]);
    const jumpToAnchor = React.useCallback<NonNullable<StructuredMessageRendererParams['onJumpToAnchor']>>((target) => {
        openPath(target.filePath, { anchor: target.anchor, anchorSource: target.source, view: target.source === 'diff' ? 'changes' : 'view' });
    }, [openPath]);
    return { canOpen: enabled, onMarkdownLinkPress, openPath, onJumpToAnchor: enabled ? jumpToAnchor : undefined };
}
