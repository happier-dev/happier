import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { ScmWorkspaceWatchRequestSchema, type ScmWorkspaceWatchRequest, type ScmWorkspaceWatchResponse, type ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveCwd } from '@/scm/runtime';
import { startScmWorkspaceWatch, type StartScmWorkspaceWatchOptions } from '@/scm/watch/startScmWorkspaceWatch';
import { filesystemPathComparisonKey, type FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { runWithWorkspaceSourceDemand, workspaceTargetUnavailable, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { FilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';

type WorkspaceWatchCallbacks = Pick<StartScmWorkspaceWatchOptions, 'onReady' | 'onChange' | 'onUnavailable'>;
type StartWorkspaceObservation = (callbacks: WorkspaceWatchCallbacks) => () => void;

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
        selectWorkspaceSource: (input: ScmWorkspaceWatchRequest, context?: RpcHandlerContext) => Promise<WorkspaceSource>;
        admitWorkspaceSource?: FilesystemEffectAdmission['rpc'];
        invalidateStatusSnapshot(): void;
        runWithRequester?(
            context: RpcHandlerContext | undefined,
            request: ScmWorkspaceWatchRequest,
            source: WorkspaceSource,
            runLocal: () => Promise<ScmWorkspaceWatchResponse>,
            observeMember: (custody: string, start: StartWorkspaceObservation) => Promise<ScmWorkspaceWatchResponse>,
        ): Promise<ScmWorkspaceWatchResponse>;
    }>,
): void {
    const observations = new Map<string, WorkspaceObservation>();
    let revision = 0;
    const observe = async (key: string, start: StartWorkspaceObservation, request: ScmWorkspaceWatchRequest,
        context?: RpcHandlerContext): Promise<ScmWorkspaceWatchResponse> => {
        let observation = observations.get(key);
        if (!observation) {
            const created: WorkspaceObservation = { revision: ++revision, ready: false, users: 0, listeners: new Set(), dispose() {} };
            const notify = () => { for (const listener of created.listeners) listener(); };
            observations.set(key, created);
            created.dispose = start({
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
                    else if (!request.observationOnly && current.ready) {
                        if (request.sinceRevision === undefined) resolve({ status: 'ready', revision: current.revision });
                        else if (request.sinceRevision !== current.revision) resolve({ status: 'changed', revision: current.revision });
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
    };
    registrar.registerHandler<unknown, ScmWorkspaceWatchResponse>(RPC_METHODS.SCM_WORKSPACE_WATCH, async (raw, context) => {
        const request = ScmWorkspaceWatchRequestSchema.safeParse(raw);
        if (!request.success) return { status: 'unavailable', reason: { code: 'invalid_request', message: 'Invalid workspace watch request' } };
        if (context?.signal.aborted) return { status: 'cancelled' };
        const { workspace } = request.data;
        try {
            const source = await options.selectWorkspaceSource(request.data, context);
            const observeLocal = (directory: string) => runWithWorkspaceSourceDemand(source, () =>
                observe(`${source.id}\0${filesystemPathComparisonKey(directory)}`,
                    callbacks => startScmWorkspaceWatch({ ...callbacks, source, directory, registry: options.registry }),
                    request.data, context));
            if (workspace) {
                if (source.kind === 'local') throw workspaceTargetUnavailable();
                if (!options.admitWorkspaceSource) return { status: 'unavailable', reason: {
                    code: 'filesystem_identity_custody_unavailable', message: 'Workspace watch admission is unavailable',
                } };
                const failure = await options.admitWorkspaceSource(context, source);
                if (failure) return { status: 'unavailable', reason: { code: failure.errorCode, message: failure.error } };
                if (context?.signal.aborted) return { status: 'cancelled' };
                return await observeLocal(workspace.rootPath);
            }
            const runLocal = async (): Promise<ScmWorkspaceWatchResponse> => {
                const root = resolveCwd(request.data.directory, workingDirectory, options.accessPolicy);
                if (!root.ok) return { status: 'unavailable', reason: { code: 'path_not_allowed', message: root.error } };
                if (context?.signal.aborted) return { status: 'cancelled' };
                return await observeLocal(root.cwd);
            };
            return options.runWithRequester
                ? await options.runWithRequester(context, request.data, source, runLocal, (custody, start) =>
                    observe(`member\0${custody}\0${filesystemPathComparisonKey(request.data.directory)}`, start, request.data, context))
                : await runLocal();
        } catch (error) {
            if (context?.signal.aborted) return { status: 'cancelled' };
            const code = readRpcErrorCode(error);
            if (!code) throw error;
            const failure = readActionFailureEnvelope({ ...readRecord(error), errorCode: code }, { treatReturnedErrorEnvelopeAsFailure: true });
            return { status: 'unavailable', reason: { code, message: error instanceof Error ? error.message : code,
                ...(failure?.failureCause === undefined ? {} : { failureCause: failure.failureCause }),
                ...(failure?.requestId === undefined ? {} : { requestId: failure.requestId }),
                ...(failure?.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
            } };
        }
    });
}
