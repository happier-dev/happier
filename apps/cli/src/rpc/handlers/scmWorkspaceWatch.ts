import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ScmWorkspaceWatchRequestSchema, type ScmWorkspaceWatchResponse, type ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveCwd } from '@/scm/runtime';
import { startScmWorkspaceWatch } from '@/scm/watch/startScmWorkspaceWatch';
import { filesystemPathComparisonKey, type FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

type WorkspaceObservation = {
    revision: number;
    ready: boolean;
    unavailable?: ScmWorkspaceWatchUnavailable;
    users: number;
    listeners: Set<() => void>;
    dispose(): void;
};

/** The Machine registrar owns one native subscription per admitted workspace. */
export function registerScmWorkspaceWatchHandler(
    registrar: RpcHandlerRegistrar,
    workingDirectory: string,
    options: Readonly<{
        accessPolicy: FilesystemAccessPolicy;
        registry?: ScmBackendRegistry;
        invalidateStatusSnapshot(): void;
    }>,
): void {
    const observations = new Map<string, WorkspaceObservation>();
    let revision = 0;
    registrar.registerHandler<unknown, ScmWorkspaceWatchResponse>(RPC_METHODS.SCM_WORKSPACE_WATCH, async (raw, context) => {
        const request = ScmWorkspaceWatchRequestSchema.safeParse(raw);
        if (!request.success) return { status: 'unavailable', reason: { code: 'invalid_request', message: 'Invalid workspace watch request' } };
        if (context?.signal.aborted) return { status: 'cancelled' };
        const root = resolveCwd(request.data.directory, workingDirectory, options.accessPolicy);
        if (!root.ok) return { status: 'unavailable', reason: { code: 'path_not_allowed', message: root.error } };
        // One subscription per workspace of one source: the same path in two sources is two workspaces.
        const source = currentWorkspaceSource();
        const key = `${source.id}\0${filesystemPathComparisonKey(root.cwd)}`;
        let observation = observations.get(key);
        if (!observation) {
            const created: WorkspaceObservation = { revision: ++revision, ready: false, users: 0, listeners: new Set(), dispose() {} };
            const notify = () => { for (const listener of created.listeners) listener(); };
            observations.set(key, created);
            created.dispose = startScmWorkspaceWatch({ source, directory: root.cwd, registry: options.registry,
                onReady: () => { options.invalidateStatusSnapshot(); created.ready = true; notify(); },
                onChange: () => { options.invalidateStatusSnapshot(); created.revision = ++revision; notify(); },
                onUnavailable: reason => { created.unavailable = reason; notify(); },
            });
            observation = created;
        }
        const current = observation;
        current.users++;
        let check: () => void = () => undefined;
        try {
            return await new Promise<ScmWorkspaceWatchResponse>(resolve => {
                check = () => {
                    if (context?.signal.aborted) resolve({ status: 'cancelled' });
                    else if (current.unavailable) resolve({ status: 'unavailable', reason: current.unavailable });
                    else if (!request.data.observationOnly && current.ready) {
                        if (request.data.sinceRevision === undefined) resolve({ status: 'ready', revision: current.revision });
                        else if (request.data.sinceRevision !== current.revision) resolve({ status: 'changed', revision: current.revision });
                    }
                };
                current.listeners.add(check);
                context?.signal.addEventListener('abort', check, { once: true });
                check();
            });
        } finally {
            current.listeners.delete(check);
            context?.signal.removeEventListener('abort', check);
            if (--current.users === 0) {
                current.dispose();
                observations.delete(key);
            }
        }
    });
}
