import { describe, expect, it, vi } from 'vitest';

import type { DaemonPatVerifier } from './auth/daemonPatVerifier';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
} from './externalActions/executeExternalAction';
import { createDaemonControlApp } from './controlServer';

type ExternalActionApi = Readonly<{
  currentServerId: string;
  verifyPat: DaemonPatVerifier;
  executor: ExternalActionExecutor;
  resolveTarget: ResolveExternalActionTarget;
}>;

function createApp(externalActionApi: ExternalActionApi) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine-local',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'success' as const, sessionId: 'session-1' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'private-control-token',
    externalActionApi,
  } as Parameters<typeof createDaemonControlApp>[0] & Readonly<{
    externalActionApi: ExternalActionApi;
  }>);
}

describe('createDaemonControlApp external Action ingress', () => {
  it('mounts the PAT-only external Action route outside the private control-token guard', async () => {
    const verifyPat = vi.fn<DaemonPatVerifier>(async () => ({
      ok: true as const,
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      expiresAt: null,
      authority: 'account_automation' as const,
    }));
    const execute = vi.fn(async () => ({ ok: true as const, result: { accepted: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target, currentMachineId }) => (
      target ?? { kind: 'machine' as const, machineId: currentMachineId }
    ));
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat,
      executor: { execute },
      resolveTarget,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: { directory: '/workspace' } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        v: 1,
        actionId: 'session.spawn_new',
        execution: { ok: true, result: { accepted: true } },
      });
      expect(verifyPat).toHaveBeenCalledWith('pat-secret', expect.any(AbortSignal));
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        'session.spawn_new',
        { directory: '/workspace' },
        expect.objectContaining({ serverId: 'server-local' }),
      );
    } finally {
      await app.close();
    }
  });
});
