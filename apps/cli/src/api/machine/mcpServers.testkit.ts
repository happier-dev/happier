import type { RpcHandlerContext } from '@/api/rpc/types';

export const MCP_TEST_HOME_ID = 'mcp-test-home';

/** The transport boundary supplies verified present-owner admission in owner probes. */
export function createMcpOwnerRpcContext(context?: RpcHandlerContext): RpcHandlerContext {
  return { ...context, signal: context?.signal ?? new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'm1',
      installationId: 'install', encryptionMode: 'plain', role: 'manage' },
    verifyMachineAdmissionCurrent: async () => !context?.signal.aborted };
}
