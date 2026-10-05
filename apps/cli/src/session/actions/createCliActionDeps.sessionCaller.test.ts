import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor, createRoleSourceReaderV1, normalizeActionsSettingsV1,
  type ActionExecutorContext } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createCliActionDeps, type SessionActionRpcTransport } from './createCliActionDeps';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';

function callerSessionFixture(callerDirectory = '/caller/repo', currentStarterDepth = 2, active = true) {
    const sessionId = 'c111111111111111111111111';
    const metadata = { path: callerDirectory, machineId: 'caller-machine', flavor: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } as const;
    const settings = accountSettingsParse({ workDepthLimit: 7 });
    // HTTP is the genuine boundary; Session resolution, opening, metadata,
    // Agent selection, and admission-context construction all remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (String(url).includes(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, active,
          encryptionMode: 'plain', metadata: JSON.stringify(metadata),
          workDepth: currentStarterDepth,
        }) } };
      }
      return { status: 404, data: {} };
    });
      const params: Parameters<typeof createCliActionDeps>[0] = {
        token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null,
        rawSession: { path: '/wrong/repo', machineId: 'wrong-machine', workDepth: 0 },
        getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
        readRoleSources: async () => [],
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}),
          getAccountSettings: () => settings },
      };
      return { sessionId, params, metadata, settings, cleanup: () => get.mockRestore() };
}

describe('daemon Account Action Session caller context', () => {
  it('fails closed for malformed Session origins before forwarding an admitted own-Session role edit', async () => {
    const { params, sessionId, metadata, settings, cleanup } = callerSessionFixture();
    const forwarded: Parameters<SessionActionRpcTransport>[0][] = [];
    try {
      const deps = createCliActionDeps({ ...params,
        readRoleSources: createRoleSourceReaderV1({}),
        // The network port is the only effect boundary; role resolution,
        // caller opening, Action admission and origin validation remain real.
        sessionActionRpcTransport: async (request) => { forwarded.push(request); return { updated: true }; },
      });
      const agentStartContext = resolveCliAgentStartContextV1({ sessionId, metadata,
        machineId: metadata.machineId, directory: metadata.path, backendTarget: metadata.backendTarget,
        starterDepth: 2, turnDepth: 3, callerPermissionMode: 'default', settings });
      if (!agentStartContext || agentStartContext.caller.kind !== 'session') throw new Error('invalid host caller fixture');
      const context: ActionExecutorContext = {
        surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
        actionCaller: agentStartContext.caller, agentStartContext,
        callerPermissionMode: 'default', actionRequestId: 'original-request',
      };
      const executor = createActionExecutor(deps);
      const input = { sessionId, notes: 'Coordinate' };
      for (const source of [undefined, null, 'untrusted-origin', 1, true,
        { sourceSessionId: 'foreign-session', sourceTurnId: 'original-turn' }]) {
        expect(await executor.execute('session.notes.set', input, { ...context, sessionInputSource: source }))
          .toMatchObject({ ok: false, errorCode: 'action_failed', error: 'role_rpc_origin_unavailable' });
        expect(forwarded).toEqual([]);
      }
      expect(await executor.execute('session.notes.set', input, { ...context,
        sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'original-turn' } }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(forwarded).toMatchObject([{ sessionId, method: 'session.notes.set', input,
        origin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
          sourceTurnId: 'original-turn', requestId: 'original-request', callerPermissionMode: 'default' } }]);
    } finally { cleanup(); }
  });

  it('uses the exact caller Session instead of the global executor host snapshot', async () => {
    // The authenticated runner owner proves liveness; Home's heartbeat
    // projection can lag and must not become a second admission decision.
    const { params, sessionId, cleanup } = callerSessionFixture('/caller/repo', 2, false);
    try {
      const deps = createCliActionDeps({ ...params, getCurrentTurnWorkDepth: () => 3 });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { machineId: 'caller-machine', directory: '/caller/repo',
          configuration: { agentTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } },
        workDepthLimit: 7,
      });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId }, defaultSessionId: 'foreign-session',
        callerPermissionMode: 'default' })).resolves.toBeNull();
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toBeNull();
    } finally { cleanup(); }
  });

  it('retains original admitted depths for replay while rebuilding the current baseline', async () => {
    const { params, sessionId, cleanup } = callerSessionFixture('/current/repo', 4);
    try {
      const replayDeps = createCliActionDeps(params);
      await expect(replayDeps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { directory: '/current/repo', machineId: 'caller-machine' }, workDepthLimit: 7,
      });
    } finally { cleanup(); }
  });
});
