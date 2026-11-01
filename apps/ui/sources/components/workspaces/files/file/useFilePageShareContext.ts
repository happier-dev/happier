import * as React from 'react';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { WorkspaceFileOpenInput } from '@happier-dev/protocol/actions/workspaceActionFamily';

import { readMountedComposerPresentationSnapshot, subscribeComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceRefById, resolveWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useWorkspaceRefs } from '@/sync/store/hooks';
import { useMachineDisplayById } from '@/sync/domains/state/storage';

/** The addressed File supplies one link, composer and publication source to every header. */
export function useFilePageShareContext(input: Readonly<{
    scope: WorkspaceScopeBase;
    accountScope: ServerAccountScope | null;
    filePath: string;
    fileRootPath?: string;
    sessionId?: string | null;
    workspaceRefId?: string | null;
    targetKind?: 'session' | 'project';
}>) {
    const refs = useWorkspaceRefs();
    const resolution = input.workspaceRefId
        ? resolveWorkspaceRefById(refs, input.workspaceRefId, input.scope.serverId)
        : resolveWorkspaceRefByScope(refs, input.scope);
    const project = resolution.kind === 'resolved' ? resolution.ref : null;
    const projectId = input.workspaceRefId ?? project?.id;
    const sessionId = input.sessionId?.trim() || null;
    const sessionSource = input.targetKind === 'session' ? sessionId : null;
    const linkInput: WorkspaceFileOpenInput | undefined = sessionSource
        ? { target: { kind: 'session', sessionId: sessionSource, serverId: input.scope.serverId }, path: input.filePath,
            ...(input.fileRootPath ? { rootPath: input.fileRootPath } : {}) }
        : projectId ? { target: { kind: 'project', workspaceRefId: projectId, ...input.scope }, path: input.filePath } : undefined;
    const ref = React.useMemo<ComposerRefV1 | null>(() => sessionId ? { kind: 'session', sessionId } : null, [sessionId]);
    const scope = input.accountScope;
    const subscribe = React.useCallback((listener: () => void) => ref
        ? subscribeComposerPresentationTarget(ref, listener) : () => {}, [ref]);
    // Observe availability only: typing in the composer must not re-render the File page.
    const readAvailable = React.useCallback(() => Boolean(ref && scope
        && readMountedComposerPresentationSnapshot({ ref, scope })), [ref, scope]);
    const mounted = React.useSyncExternalStore(subscribe, readAvailable, readAvailable);
    const composer = mounted && scope && ref ? { scope, ref, workspace: input.scope } : null;
    const homeDir = useMachineDisplayById(machines => machines[input.scope.machineId]?.metadata?.homeDir ?? null);
    return { linkInput, composer, sourceSessionId: sessionSource, sourceProject: project,
        homeDir };
}
