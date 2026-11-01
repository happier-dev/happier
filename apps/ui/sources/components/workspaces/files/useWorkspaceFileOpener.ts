import * as React from 'react';
import type { z } from 'zod/mini';
import type { WorkspaceFileOpenInput, WorkspaceFileTarget, WorkspaceFindSeedSchema } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { executeWorkspaceUiAction, openWorkspaceHrefOrElse, resolveWorkspaceUiActionOutcome } from '@/components/appShell/workspace/workspaceActionRuntime';
import { useWorkspaceFileNavigationCapabilities } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import type { Href } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { setTranscriptJumpHighlight, type TranscriptJumpHighlightRowIdentity } from '@/components/sessions/transcript/navigation/transcriptJumpHighlightStore';
import { useOptionalAppPaneContext, useOptionalPaneFocusReturnOwner } from '@/components/appShell/panes/AppPaneContext';
import { usePaneRegion } from '@/components/appShell/panes/paneRegion';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { areSessionAddressesEqual, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { workspaceFileDetailsTabKey } from '@/components/appShell/panes/details/fileDetailsTab';

export type WorkspaceFileOpenTarget = WorkspaceFileTarget & Readonly<{ path: string }>;
export type WorkspaceFileOpenOrigin = Readonly<{
    focusReturnRef?: FocusReturnRef;
    transcript?: TranscriptJumpHighlightRowIdentity;
}>;
export type WorkspaceFileOpenOptions = Readonly<Pick<WorkspaceFileOpenInput, 'anchor' | 'anchorSource' | 'view' | 'blame' | 'changesScope' | 'rootPath'> & {
    intent?: 'preview' | 'pinned' | 'beside';
    present?: boolean;
    find?: z.infer<typeof WorkspaceFindSeedSchema>;
    signal?: AbortSignal;
    origin?: WorkspaceFileOpenOrigin;
    /** Placement succeeded, not just a deferred approval: a caller may now reveal the retained pane. */
    onOpened?: () => void;
}>;
/** True accepts the request (including deferred approval); false refuses it; null cancels it. */
export type WorkspaceFileOpen = (target: WorkspaceFileOpenTarget, options?: WorkspaceFileOpenOptions) => Promise<boolean | null>;

/** Every file entry point enters the same Action policy and mounted navigation owner. */
export function useWorkspaceFileOpener() {
    const { canOpen, phone } = useWorkspaceFileNavigationCapabilities();
    const router = useDestinationRouter();
    const focusReturnOwner = useOptionalPaneFocusReturnOwner();
    const instance = React.useContext(DestinationInstanceContext);
    const instanceKey = instance?.tabId ?? null;
    const destinationNavigation = instance?.navigation;
    // The route carries the file into Details without the column it was opened from, so the opener
    // names it first; the pane layout keeps Details off that column (details lab opener rule).
    const paneRegion = usePaneRegion();
    const paneDispatch = useOptionalAppPaneContext(value => ({ dispatch: value.dispatch }))?.dispatch;
    const openApproval = React.useCallback((href: Href) => {
        if (destinationNavigation) destinationNavigation.push(href);
        else fireAndForget(openWorkspaceHrefOrElse(resolveHref(href), () => router.push(href)), { tag: 'useWorkspaceFileOpener.openApproval' });
    }, [destinationNavigation, router]);
    const open = React.useCallback(async (target: WorkspaceFileOpenTarget, options?: WorkspaceFileOpenOptions): Promise<boolean | null> => {
        if (options?.signal?.aborted) return null;
        if (!canOpen) return false;
        const { path, ...address } = target;
        if (paneDispatch && options?.present !== false && (paneRegion === 'main' || paneRegion === 'side')) {
            const scopeId = target.kind === 'project'
                ? buildProjectPaneScopeId(target.workspaceRefId, target.serverId, instanceKey)
                : createSessionPaneScopeId(target.sessionId, target.serverId, instanceKey);
            paneDispatch({ type: 'recordDetailsOpener', scopeId, origin: paneRegion });
        }
        const result = await executeWorkspaceUiAction({ actionId: 'workspace.tabs.open', input: {
            file: { target: address, path,
                ...(options?.rootPath ? { rootPath: options.rootPath } : {}),
                ...(options?.anchor ? { anchor: options.anchor } : {}),
                ...(options?.anchorSource ? { anchorSource: options.anchorSource } : {}),
                ...(options?.view ? { view: options.view } : {}),
                ...(options?.blame === undefined ? {} : { blame: options.blame }),
                ...(options?.changesScope ? { changesScope: options.changesScope } : {}),
            },
            mode: options?.intent === 'beside' ? 'splitRight' : options?.intent === 'pinned' ? 'newTab' : 'preview',
            ...(options?.present === undefined ? {} : { present: options.present }),
            ...(options?.present === false && instanceKey ? { tabId: instanceKey } : {}),
            ...(options?.find ? { find: options.find } : {}),
        }, ...(options?.signal ? { signal: options.signal } : {}) }, openApproval);
        const opened = result.ok && !ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;
        if (opened) options?.onOpened?.();
        const origin = options?.origin;
        const transcript = origin?.transcript;
        // A transcript knows its exact retained instance. Cross-session/project callers
        // do not invent an instance or attach their focus to an unrelated destination.
        if (opened && options?.present !== false && origin && target.kind === 'session' && transcript?.sessionAddress
            && areSessionAddressesEqual(transcript.sessionAddress, normalizeSessionAddress(target.serverId, target.sessionId))) {
            const scopeId = createSessionPaneScopeId(target.sessionId, target.serverId, instanceKey);
            focusReturnOwner?.recordDetailsTabOrigin(scopeId, workspaceFileDetailsTabKey(path, options?.rootPath), {
                focusReturnRef: origin.focusReturnRef,
                onReturn: kind => { if (kind === 'route') setTranscriptJumpHighlight(transcript); },
            }, phone ? 'route' : 'pane');
        }
        return resolveWorkspaceUiActionOutcome(result);
    }, [canOpen, focusReturnOwner, instanceKey, openApproval, paneDispatch, paneRegion, phone]);
    return React.useMemo(() => ({ open, canOpen }), [open, canOpen]);
}
