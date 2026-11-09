import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { createDaemonControlApp, type startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { readRetainedExecutionRunRecord, retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { readStoredCredentialsForServerId, writeDaemonState, writeStoredCredentialsForServerId } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Replace only the fixture's OS listener publication. The test opens a real
// localhost listener with those same production daemon owners below.
vi.mock('@/daemon/controlServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

it.each(['execution.run.get', 'execution.run.stop'] as const)(
  'keeps credential-derived owner access and refuses foreign retained Runs through local HTTP (%s)', async actionId => {
    const homeId = 'srv_local_run_account';
    const serverId = 'local-run-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' } as const;
    const accountSettings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {},
      approvalWaivedSurfaces: { 'execution.run.stop': ['cli', 'rpc'] } } });
    const nativeFetch = globalThis.fetch;
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
      credentials, accountActionCredentials: credentials, requesterCredentials: credentials,
      serverId, externalActionAccountId: 'requester', ordinaryAccountSession: true,
      homeServerIdentityId: homeId, accountSettings,
      machineAccess: { custodianAccountId: 'requester', role: 'manage' },
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    });
    const homeFetch = globalThis.fetch;
    const homePost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, ...args) => {
      // This ordinary installed Machine has no managed power resource.
      if (new URL(String(url)).pathname === '/v1/machines/managed/actions/list')
        return { status: 200, data: { machines: [] } };
      return homePost(url, ...args);
    });
    // Preserve the canonical Home network fixture while exercising actual HTTP
    // for daemon discovery, authentication and the root Action request.
    vi.stubGlobal('fetch', ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === '127.0.0.1' ? nativeFetch(input, init) : homeFetch(input, init);
    }) satisfies typeof fetch);
    const features = { status: 'ready' as const,
      features: FeaturesResponseSchema.parse({ features: { execution: { runs: { enabled: true } } } }) };
    h.machine.setRPCHandlers({ spawnSession: h.daemon.spawnSession, stopSession: h.daemon.stopSession, requestShutdown() {} }, {
      externalActionIngressOwner: h.daemon.externalActionIngressOwner,
      getServerFeaturesSnapshot: () => features, resolveServerFeaturesSnapshot: () => features,
    });
    const run: ExecutionRunState = {
      runId: 'owner-run', callId: 'owner-call', sidechainId: 'owner-sidechain', sessionId: null,
      depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
      instructions: 'Retained private owner input', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, finishedAtMs: 2,
      requesterWorkAttributionV1: { serverId: homeId, accountId: 'requester', machineId: 'machine',
        installationId: h.f.installation.installationId },
    };
    await retainExecutionRunState(run);
    await retainExecutionRunState({ ...run, runId: 'foreign-run', callId: 'foreign-call', sidechainId: 'foreign-sidechain',
      requesterWorkAttributionV1: { ...run.requesterWorkAttributionV1!, accountId: 'another-account' } });
    const control = boundary.control;
    if (!control?.externalActionApi) throw new Error('Missing installed daemon Action ingress');
    // Requester Session setup may replace its own credential projection. Publish
    // the installed Account session used by this independent local CLI request.
    await writeStoredCredentialsForServerId(serverId, credentials);
    expect(control.externalActionApi.currentServerId).toBe(serverId);
    expect(control.externalActionApi.currentAccountId).toBe('requester');
    expect((await readStoredCredentialsForServerId(serverId))?.token === credentials.token).toBe(true);
    const controlToken = 'local-run-control';
    const app = createDaemonControlApp({ ...control, controlToken });
    const rootRequests: string[] = [];
    app.addHook('preHandler', async request => { rootRequests.push(request.url); });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing local control listener');
      writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
        httpPort: address.port, controlToken, machineId: 'machine', accountId: 'requester' });
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId,
        serverApiUrl: 'https://session-home.test', serverIdentityId: homeId, machineId: 'machine', externalActionClient: true,
        readCredentials: async () => credentials,
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings }),
      });
      let manager: ExecutionRunHostBridge | undefined;
      if (actionId === 'execution.run.stop') {
        // Observe recovery without replacing it. The real Get discovers the
        // installed bridge; seed already-admitted live work at that owner.
        const recovery = vi.spyOn(ExecutionRunHostBridge.prototype, 'recoverRetainedRuns');
        expect(await executor.execute('execution.run.get', { sessionId: null, runId: 'owner-run' },
          { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true });
        const recovered = recovery.mock.contexts.find(context => context instanceof ExecutionRunHostBridge
          && context.get('owner-run'));
        if (!(recovered instanceof ExecutionRunHostBridge)) throw new Error('Missing installed Run bridge');
        manager = recovered;
        for (const runId of ['owner-run', 'foreign-run']) {
          const live = manager.get(runId);
          if (!live) throw new Error('Missing recovered Run');
          live.status = 'running';
          delete live.finishedAtMs;
          await retainExecutionRunState(live);
        }
      }
      const beforeForeign = await readRetainedExecutionRunRecord('foreign-run');
      // No requester identity or private custody enters the caller's input/context.
      const foreign = await executor.execute(actionId, { sessionId: null, runId: 'foreign-run' },
        { surface: 'cli', authority: 'present_user' });
      expect(rootRequests, JSON.stringify(foreign)).toContain('/actions/root/execute');
      expect(foreign, JSON.stringify(foreign)).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
      expect(await readRetainedExecutionRunRecord('foreign-run')).toEqual(beforeForeign);
      const owner = await executor.execute(actionId, { sessionId: null, runId: 'owner-run' },
        { surface: 'cli', authority: 'present_user' });
      expect(owner, JSON.stringify(owner)).toMatchObject(actionId === 'execution.run.get'
        ? { ok: true, result: { run: { runId: 'owner-run' } } } : { ok: true });
      if (actionId === 'execution.run.stop') {
        expect(await executor.execute('execution.run.get', { sessionId: null, runId: 'owner-run' },
          { surface: 'cli', authority: 'present_user' }))
          .toMatchObject({ ok: true, result: { run: { runId: 'owner-run', status: 'cancelled' } } });
        expect(manager?.get('foreign-run')?.status).toBe('running');
        expect(await readRetainedExecutionRunRecord('foreign-run')).toEqual(beforeForeign);
      }
    } finally { await app.close(); }
  },
);
