import axios from 'axios';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { logger } from '@/ui/logger';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reloadConfiguration } from '@/configuration';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the private listener and Home HTTP are substituted. Runner custody,
// Session Action dispatch, Account preparation and failure projection are real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); boundary.control = null; });
afterAll(() => pluginReloadController.shutdown());

it.each(['exception', 'database', 'carried refusal'] as const)(
  'preserves the first cause of a Session Account Action %s instead of inventing a target refusal', async scenario => {
    const home = 'srv_session_action_failure';
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
      ordinaryAccountSession: true, externalActionAccountId: 'requester', homeServerIdentityId: home,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
      agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
    });
    const serverId = h.f.bootstrap.attribution.serverId;
    await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId,
      servers: { [serverId]: { id: serverId, name: 'Failure Home', serverUrl: 'https://session-home.test',
        webappUrl: 'https://session-home.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: home,
          canonicalServerUrl: 'https://session-home.test', revision: 1,
          endpoints: [{ kind: 'https', url: 'https://session-home.test' }] },
      } }, machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' },
    });
    reloadConfiguration();
    const installed = await h.machine.resolveInstalledAccountObservationRuntime(h.signal);
    expect(installed?.accountId).toBe('requester');
    expect(await installed?.isCurrent()).toBe(true);
    const originalRead = vi.mocked(axios.get).getMockImplementation()!;
    const cause = scenario === 'exception' ? new TypeError('synthetic-private-input')
      : Object.assign(new Error('synthetic-private-query'), { name: 'PrismaClientKnownRequestError', code: 'P2028' });
    const carried = { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { requiredFact: 'machine_installation_origin' } };
    let failedRead = false;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === '/v1/account/profile') {
        failedRead = true;
        throw scenario === 'carried refusal' ? new Error('synthetic-private-wrapper', { cause: carried }) : cause;
      }
      return originalRead(...args);
    });
    const warning = vi.spyOn(logger, 'warnLocalFile');
    const response = await h.dispatch({ kind: 'action.execute', surface: 'agent', actionId: 'artifact.delete',
      requestId: h.operationBase().requestId, input: { artifactId: 'own-draft', expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
      witness: { turnId: 'failure-turn', inputId: 'failure-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
        agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
    });
    expect(failedRead, JSON.stringify(response)).toBe(true);
    if (scenario === 'carried refusal') {
      expect(response).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: carried } });
    } else {
      const failureCause = { phase: 'session_account.credentialed_factory',
        errorClass: scenario === 'exception' ? 'TypeError' : 'PrismaClientKnownRequestError',
        errorCode: scenario === 'exception' ? null : 'P2028', httpStatus: null };
      expect(response).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: {
        ok: false, errorCode: 'internal_error', error: 'internal_error', failureCause,
      } } });
      expect(warning).toHaveBeenCalledWith('[Session Account Action] Failed', expect.objectContaining({ failureCause }));
      expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic-private');
    }
    expect(JSON.stringify(response)).not.toContain('synthetic-private');
    expect(h.nativeEffects()).toBe(0);
  }, 120_000,
);
