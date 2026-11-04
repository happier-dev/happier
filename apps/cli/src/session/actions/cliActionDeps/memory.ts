import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { isMemorySessionSearchHitV1, negotiateMemorySearchV1 } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryStatusV1Schema, type MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { MemorySettingsV1Schema } from '@happier-dev/protocol/memory/memorySettings';
import { MemoryWindowV1Schema } from '@happier-dev/protocol/memory/memoryWindow';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
export function createCliMemoryActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'serverHttpBaseUrl'>,
  { callMachineAction, isMachineActionServerScopeCurrent, notSupported }: Readonly<{
    callMachineAction: CliMachineActionCall;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
    notSupported: () => never;
  }>,
): Pick<ActionExecutorDeps, 'daemonMemorySettingsGet' | 'daemonMemorySettingsSet' | 'daemonMemoryStatus' | 'daemonMemoryClearIndex' | 'daemonMemorySearch' | 'daemonMemoryGetWindow' | 'daemonMemoryEnsureUpToDate'> & Required<Pick<ActionExecutorDeps, 'daemonMemorySearch' | 'daemonMemoryEnsureUpToDate' | 'daemonMemoryGetWindow'>> {
  return {

    daemonMemorySettingsGet: async ({ machineId, context, serverId, signal }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return notSupported();
      return MemorySettingsV1Schema.parse(await callMachineAction({ machineId, method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
        request: {}, context, effectActionId: 'search.settings.get', authority: context.authority, exactMachine: true,
        ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) }));
    },
    daemonMemorySettingsSet: async ({ machineId, settings, context, serverId, signal }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return notSupported();
      return MemorySettingsV1Schema.parse(await callMachineAction({ machineId, method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
        request: settings, context, effectActionId: 'search.settings.set', authority: context.authority, exactMachine: true,
        ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) }));
    },
    daemonMemoryStatus: async ({ machineId, context, serverId, signal }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return notSupported();
      return MemoryStatusV1Schema.parse(await callMachineAction({ machineId, method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        request: {}, context, effectActionId: 'memory.status', authority: context.authority, exactMachine: true,
        timeoutMs: null,
        ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) }));
    },
    daemonMemoryClearIndex: async ({ machineId, context, serverId, signal }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) return notSupported();
      const result = await callMachineAction({ machineId, method: RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX,
        request: {}, context, effectActionId: 'memory.clear_index', authority: context.authority, exactMachine: true,
        ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) });
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('memory_clear_index_failed');
      return { ok: true };
    },
    daemonMemorySearch: async ({ machineId, query, serverId, signal }) => {
      const credentials = params.credentials;
      if (!credentials) return notSupported();
      const documentsRequested = query.corpora?.includes('documents') === true;
      const exactScopeRequired = documentsRequested || query.scope.type === 'project';
      if (exactScopeRequired && !await isMachineActionServerScopeCurrent({ serverId, machineId, signal })) {
        return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'Exact Home scope is unavailable.' };
      }
      // A capability on one daemon cannot authorize a successor or another
      // Home. Keep released transcript-only target replacement unchanged.
      const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const { callExactMachineRpc, callMachineRpc } = await import("@/session/transport/rpc/machineRpc");
      const callMemoryRpc = async (method: string, request: unknown) =>
        readMachineActionRpcResult(await (exactScopeRequired ? callExactMachineRpc : callMachineRpc)({
          credentials, machineId, method, request, timeoutMs: null,
          ...(exactScopeRequired ? { serverUrl } : {}),
          ...(signal ? { signal } : {}),
        }));
      let status: Promise<MemoryStatusV1> | undefined;
      const readStatus = () => status ??= callMemoryRpc(RPC_METHODS.DAEMON_MEMORY_STATUS, {})
        .then(value => MemoryStatusV1Schema.parse(value));
      const result = await negotiateMemorySearchV1({
        query,
        readDocumentSearchSupport: async () => (await readStatus()).documentSearchSupported === true,
        readProjectSearchSupport: async () => (await readStatus()).projectSearchSupported === true,
        search: async (request) => await callMemoryRpc(RPC_METHODS.DAEMON_MEMORY_SEARCH, request),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) return result;

      const visibleThroughSeqBySessionId = new Map<string, number>();
      const sessionIds = [...new Set(result.hits.flatMap((hit) =>
        isMemorySessionSearchHitV1(hit) ? [hit.sessionId] : [],
      ))];
      const { fetchSessionById } = await import("@/session/transport/http/sessionsHttp");
      await Promise.all(sessionIds.map(async (sessionId) => {
        try {
          const session = await fetchSessionById({
            reason: 'session-action',
            token: credentials.token,
            sessionId,
            ...(exactScopeRequired ? { serverUrl } : {}),
            ...(signal ? { signal } : {}),
          });
          if (session && Number.isSafeInteger(session.seq) && session.seq >= 0) {
            visibleThroughSeqBySessionId.set(sessionId, session.seq);
          }
        } catch {
          signal?.throwIfAborted();
          // The daemon index is derived state. An unreadable Session cannot be
          // returned as Action data, even when its retained summary still exists.
        }
      }));
      signal?.throwIfAborted();
      return {
        ...result,
        hits: result.hits.filter((hit) => {
          // The daemon admits Artifact and native transcript sources. Only
          // Happier Session ranges need this caller-visible sequence check.
          if (!isMemorySessionSearchHitV1(hit)) return true;
          const visibleThroughSeq = visibleThroughSeqBySessionId.get(hit.sessionId);
          return visibleThroughSeq !== undefined
            && hit.seqFrom <= visibleThroughSeq
            && hit.seqTo <= visibleThroughSeq;
        }),
      };
    },
    daemonMemoryGetWindow: async ({ machineId, serverId, signal, ...request }) => {
      if (!params.credentials) return notSupported();
      if (request.source !== undefined) {
        if (!await isMachineActionServerScopeCurrent({ serverId, machineId, signal })) throw Object.assign(
          new Error('Exact Home scope is unavailable.'), { code: 'not_authenticated' as const });
        const { callExactMachineRpc } = await import("@/session/transport/rpc/machineRpc");
        return MemoryWindowV1Schema.parse(readMachineActionRpcResult(await callExactMachineRpc({ credentials: params.credentials,
          machineId, serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, request: { ...request, v: 1 },
          ...(signal ? { signal } : {}),
        })));
      }
      const { sessionId, seqFrom, seqTo } = request;
      const [{ fetchSessionById }, { callMachineRpc }] = await Promise.all([import("@/session/transport/http/sessionsHttp"), import("@/session/transport/rpc/machineRpc")]);
      const session = await fetchSessionById({
        reason: 'session-action',
        token: params.credentials.token,
        sessionId,
        ...(signal ? { signal } : {}),
      });
      const visibleThroughSeq = session?.seq;
      if (
        typeof visibleThroughSeq !== 'number'
        || !Number.isSafeInteger(visibleThroughSeq)
        || visibleThroughSeq < 0
        || seqFrom > visibleThroughSeq
        || seqTo > visibleThroughSeq
      ) {
        throw Object.assign(
          new Error('Memory window is outside the current Session projection.'),
          { code: 'not_authenticated' as const },
        );
      }
      return MemoryWindowV1Schema.parse(readMachineActionRpcResult(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        request: { v: 1, sessionId, seqFrom, seqTo },
        ...(signal ? { signal } : {}),
      })));
    },
    daemonMemoryEnsureUpToDate: async ({ machineId, sessionId }) => {
      if (!params.credentials) return notSupported();
      const { callMachineRpc } = await import("@/session/transport/rpc/machineRpc");
      return readMachineActionRpcResult(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: sessionId ? { sessionId } : {},
        // The Memory worker owns the awaited indexing lifetime.
        timeoutMs: null,
      }));
    },
  };
}

