import { join } from 'node:path';
import type { z } from 'zod/mini';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { getLanguageServerHost, type LanguageServerHost } from '@/lsp/languageServerHost';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import {
  DaemonLspQueryRequestSchema, DaemonLspRestartRequestSchema, DaemonLspSyncRequestSchema, DaemonLspWatchRequestSchema,
} from '@happier-dev/protocol/machines/languageIntelligence';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';

type TransportFailure = Readonly<{ status: 'error'; errorCode: 'invalid_request' | 'path_not_allowed' | 'cancelled' | 'request_failed' }>;

/** Transport admission only. The process-scoped host owns every document and server. */
export function registerLanguageIntelligenceHandlers(
  registrar: RpcHandlerRegistrar,
  workingDirectory: string,
  options?: Readonly<{ accessPolicy?: FilesystemAccessPolicy; host?: LanguageServerHost; machineId?: string; serverId?: string; resolveActionExecutor?: () => RpcActionExecutor | null }>,
): void {
  const accessPolicy = options?.accessPolicy ?? { kind: 'osUser' };
  function register<Request extends { rootPath: string }, Response>(
    method: string,
    schema: z.ZodMiniType<Request>,
    paths: (request: Request) => readonly string[],
    invoke: (host: LanguageServerHost, request: Request, context: Parameters<LanguageServerHost['sync']>[1]) => Promise<Response>,
  ): void {
    registrar.registerHandler<unknown, Response | TransportFailure>(method, async (raw, context) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { status: 'error', errorCode: 'invalid_request' };
      try {
        const root = authorizeFilesystemPath({ targetPath: parsed.data.rootPath, defaultDirectory: workingDirectory, accessPolicy });
        if (!root.valid) return { status: 'error', errorCode: 'path_not_allowed' };
        // The selected workspace is a narrower authority than the Machine's OS
        // access policy. The existing authorizer also resolves symlink ancestors.
        for (const path of paths(parsed.data)) {
          const document = authorizeFilesystemPath({ targetPath: join(root.resolvedPath, path), defaultDirectory: root.resolvedPath,
            accessPolicy: { kind: 'restrictedRoots', roots: [root.resolvedPath] } });
          if (!document.valid) return { status: 'error', errorCode: 'path_not_allowed' };
        }
        if (context?.signal.aborted) return { status: 'error', errorCode: 'cancelled' };
        return await invoke(options?.host ?? getLanguageServerHost(), { ...parsed.data, rootPath: root.resolvedPath }, {
          signal: context?.signal, requesterWorkAttributionV1: projectRpcRequesterWorkAttribution(context, options?.serverId),
        });
      } catch (error) {
        return { status: 'error', errorCode: context?.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'cancelled' : 'request_failed' };
      }
    });
  }
  register(RPC_METHODS.DAEMON_LSP_SYNC, DaemonLspSyncRequestSchema,
    ({ op }) => op.op === 'external' ? op.paths : op.op === 'close' ? [] : [op.path],
    (host, request, context) => host.sync(request, context));
  register(RPC_METHODS.DAEMON_LSP_QUERY, DaemonLspQueryRequestSchema, (request) => [request.path],
    (host, request, context) => host.query(request, context));
  register(RPC_METHODS.DAEMON_LSP_WATCH, DaemonLspWatchRequestSchema, () => [],
    (host, request, context) => host.watch(request, context));
  register(RPC_METHODS.DAEMON_LSP_RESTART, DaemonLspRestartRequestSchema, () => [],
    (host, request, context) => host.restart(request, context));
  registerActionSpecRpcHandlers({
    rpcHandlerManager: registrar, actionIds: ['code.rename.apply', 'code.file.rename.apply', 'code.codeAction.apply', 'code.format.apply', 'code.imports.organize'],
    ...(options?.machineId ? { targetMachineId: options.machineId, defaultMachineTarget: true } : {}),
    resolveActionExecutor: () => options?.resolveActionExecutor?.() ?? { execute: async () => ({ ok: false, errorCode: 'language_intelligence_action_owner_unavailable', error: 'Language Action admission is unavailable' }) },
  });
}
