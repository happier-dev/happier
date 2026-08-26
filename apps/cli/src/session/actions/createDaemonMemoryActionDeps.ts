import {
  MemorySearchResultV1Schema,
  MemoryWindowV1Schema,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

type DaemonMemoryActionDeps = Pick<
  ActionExecutorDeps,
  'daemonMemorySearch' | 'daemonMemoryGetWindow' | 'daemonMemoryEnsureUpToDate'
>;

export function createDaemonMemoryActionDeps(params: Readonly<{
  invoke: (args: Readonly<{
    machineId: string;
    method: string;
    request: unknown;
  }>) => Promise<unknown>;
}>): DaemonMemoryActionDeps {
  return {
    daemonMemorySearch: async ({ machineId, query }) => MemorySearchResultV1Schema.parse(
      await params.invoke({
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        request: query,
      }),
    ),
    daemonMemoryGetWindow: async ({ machineId, sessionId, seqFrom, seqTo }) => MemoryWindowV1Schema.parse(
      await params.invoke({
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        request: { v: 1, sessionId, seqFrom, seqTo },
      }),
    ),
    daemonMemoryEnsureUpToDate: async ({ machineId, sessionId }) => await params.invoke({
      machineId,
      method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
      request: sessionId ? { sessionId } : {},
    }),
  };
}
