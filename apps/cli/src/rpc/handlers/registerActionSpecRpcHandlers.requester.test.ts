import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

describe('Machine work starts requester credential ownership', () => {
  it.each(['session.spawn_new', 'execution.run.start', 'workflow.run.start'] as const)(
    'refuses %s before a foreign requester reaches the custodian Action executor', async (actionId) => {
      const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
      registerActionSpecRpcHandlers({
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
        actionIds: [actionId],
        actionExecutor: createActionExecutor(createCliActionDeps({ token: 'custodian-token', sessionId: '', mode: 'plain', ctx: null })),
      });
      const handler = [...handlers.values()][0];
      expect(handler).toBeDefined();
      if (!handler) throw new Error('Work start RPC registration unavailable');
      expect(await handler({}, { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
      })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    },
  );
});
