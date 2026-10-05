import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliActionDeps } from './createCliActionDeps';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

const boundary = vi.hoisted(() => ({ get: vi.fn(), rpc: vi.fn() }));
// Only authenticated HTTP and Machine RPC are replaced; Session routing and Actions stay real.
vi.mock('axios', () => ({ default: { get: boundary.get, isAxiosError: () => false } }));
vi.mock('@/session/transport/rpc/machineRpc', async (original) => ({
  ...await original<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: boundary.rpc,
}));
const sessionId = 'c111111111111111111111111';
const pullRequest = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
  number: 42, title: 'Fix', url: 'https://github.com/acme/widgets/pull/42', baseBranch: 'main', headBranch: 'fix', state: 'open' };
describe('CLI session pull request binding', () => {
  beforeEach(() => {
    boundary.get.mockReset(); boundary.rpc.mockReset();
    boundary.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.includes('/v3/automations?')) return { status: 200, data: { automations: [], nextCursor: null } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'plain', dataEncryptionKey: null, metadata: JSON.stringify({ machineId: 'session-machine', path: '/repo' }), metadataVersion: 1,
        agentState: null, agentStateVersion: 0 } } };
      throw new Error(`unexpected_http:${url}`);
    });
  });
  it.each([sessionId, 'different-session'] as const)('accepts only PR-link reads qualified for the requested Session: %s', async (echoSessionId) => {
    boundary.rpc.mockResolvedValue({ kind: 'links', sessionId: echoSessionId, pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 42 }] });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
      }) }),
    });
    const result = await deps.workflowAction!({ actionId: 'session.trigger.list', input: { sessionId }, context: { surface: 'cli', actionCaller: { kind: 'host' } } });
    expect(result).toMatchObject(echoSessionId === sessionId
      ? { sessionId, pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 42 }] }
      : { sessionId, sets: [], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } });
  });
  it('lists Session triggers with unavailable PR links when the Session Machine is offline', async () => {
    boundary.rpc.mockRejectedValue(new Error('Machine offline'));
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
      }) }),
    });
    await expect(deps.workflowAction!({ actionId: 'session.trigger.list', input: { sessionId }, context: { surface: 'cli', actionCaller: { kind: 'host' } } }))
      .resolves.toMatchObject({ sessionId, sets: [], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } });
  });
  it.each(['created', 'reused'] as const)('links a successful %s PR on the originating Session machine', async (result) => {
    const effects: unknown[] = [];
    boundary.rpc.mockImplementation(async (request: { machineId: string; method: string; request: unknown }) => {
      if (request.method === 'scm.pullRequest.openOrReuse') return { success: true, pullRequest, result, nextAction: { kind: 'none' } };
      if (request.method === 'action.invoke') { effects.push(request); return { kind: 'attached', bindingId: 'binding-one' }; }
      throw new Error(`unexpected_rpc:${request.method}`);
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo', base: { kind: 'branch', name: 'main' } },
      context: { defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toMatchObject({ success: true, result });
    expect(effects).toEqual([expect.objectContaining({ machineId: 'session-machine', request: expect.objectContaining({
      input: { action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' }, input: { kind: 'attach', sessionId, pullRequest: { repository: 'acme/widgets', number: 42 } } },
      defaultSessionId: sessionId,
    }) })]);
  });
  it('keeps an originless successful PR out of Session binding writes', async () => {
    boundary.rpc.mockResolvedValue({ success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo' },
      context: { externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toMatchObject({ success: true });
    expect(boundary.rpc.mock.calls.map(([input]) => input.method)).toEqual(['scm.pullRequest.openOrReuse']);
  });
  it('surfaces failed link admission without concealing the already-created native PR', async () => {
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => method === 'action.invoke'
      ? { ok: false, errorCode: 'denied', error: 'denied' }
      : { success: true, pullRequest, result: 'created', nextAction: { kind: 'none' } });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null });
    await expect(deps.scmActionExecute!({ actionId: 'scm.pullRequest.openOrReuse', input: { cwd: '/repo' },
      context: { defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId: 'scm-machine' } },
      executeCanonicalAction: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'denied', details: { scmEffectCommitted: true, pullRequest: { number: 42 } } });
  });
});
