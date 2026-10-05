import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createCliActionDeps } from './createCliActionDeps';

function callerSessionFixture(callerDirectory = '/caller/repo', currentStarterDepth = 2, active = true) {
    const sessionId = 'c111111111111111111111111';
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
          encryptionMode: 'plain', metadata: JSON.stringify({ path: callerDirectory, machineId: 'caller-machine',
            flavor: 'codex', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } }),
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
          getAccountSettings: () => accountSettingsParse({ workDepthLimit: 7 }) },
      };
      return { sessionId, params, cleanup: () => get.mockRestore() };
}

describe('daemon Account Action Session caller context', () => {
  it('uses the exact caller Session instead of the global executor host snapshot', async () => {
    // The authenticated runner owner proves liveness; Home's heartbeat
    // projection can lag and must not become a second admission decision.
    const { params, sessionId, cleanup } = callerSessionFixture('/caller/repo', 2, false);
    try {
      const deps = createCliActionDeps({ ...params, getCurrentTurnWorkDepth: () => 3 });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { machineId: 'caller-machine', directory: '/caller/repo',
          configuration: { agentTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } },
        workDepthLimit: 7,
      });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: 'foreign-session',
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
