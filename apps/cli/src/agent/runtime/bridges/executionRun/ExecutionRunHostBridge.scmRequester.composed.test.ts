import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterAll, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { reloadConfiguration } from '@/configuration';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { runWithRealGitScmRuntime } from '../../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';

const home = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import('node:fs/promises'), import('node:os'), import('node:path'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'happier-scm-requester-home-'));
  const original = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = directory;
  return { directory, original };
});
const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
// Physical persisted credentials are the runtime's own Account, never the child requester.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token, encryption: null }),
}));

afterAll(async () => {
  await pluginReloadController.shutdown();
  if (home.original === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = home.original;
  reloadConfiguration();
  await rm(home.directory, { recursive: true, force: true });
});

it.each(['owner', 'guest', 'foreign-installation', 'root-owner', 'root-guest', 'root-foreign-installation',
  'root-stale', 'root-unverified'] as const)(
  'retains the admitted %s requester from a detached Run through SDK SCM and receiving RPC', async control => runWithRealGitScmRuntime(async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-requester-' });
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-requester-fixture-'));
    await writeFile(join(repository.rootPath, repository.trackedPath), 'pending review change\n');
    const rootOnly = control.startsWith('root-');
    const guest = control.endsWith('guest');
    const foreign = control.endsWith('foreign-installation');
    const actorAccountId = guest ? 'guest' : 'owner';
    const machineAdmission = { actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
      installationId: foreign ? 'foreign' : 'installation',
      role: 'manage' as const, encryptionMode: 'plain' as const };
    const verifiedActors: string[] = [];
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine', resolveHomeServerIdentityId: async () => 'home',
        resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
        // Home's permission response is the external boundary. A guest has no
        // raw repository grant; it must never borrow the daemon owner's stamp.
        verifyMachineAdmission: async ({ context }) => { verifiedActors.push(context.actorAccountId); return context.actorAccountId === 'owner'; },
      }) });
    registerScmHandlers(rpc, repository.rootPath, { machineId: 'machine', registry: createTestGitScmBackendRegistry() });
    let response: unknown;
    let failure: unknown;
    const responseReady = Promise.withResolvers<void>();
    const plugin = definePlugin({ id: 'test.scm-requester', version: '0.0.0', displayName: 'SCM requester boundary',
      entrypoints: { daemon: './daemon.mjs' }, agents: { reviewer: {
        declaration: { title: 'SCM requester', runtime: { kind: 'custom' }, primary: 'executionRuns',
          capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } },
        factory: () => ({ executionRuns: { open: async (_request, context: AgentExecutionRunRuntimeContextV1) => {
          try {
            response = await context.services.actions.execute('scm.status.snapshot', { cwd: repository.rootPath,
              includeWorktreeStatus: false });
          } catch (error) { failure = error; throw error; }
          responseReady.resolve();
          return { async send() { return { status: 'admitted' as const }; }, async stop() { return { status: 'requested' as const }; },
            watch: () => ({ dispose() {} }), async dispose() {} };
        } } }),
      } } });
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home read'));
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
      if (availability) return availability;
      throw new Error(`Unexpected Home request: ${new URL(String(url)).pathname}`);
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      happyHomeDir: home.directory,
      runtimeOptions: { resolveCurrentMachineId: () => 'machine',
        scopedActionRuntime: { credentials: { token, encryption: null }, actionsSettingsProvider: createActionSettingsProvider() },
        agentIsolation: {
          requesterIdentity: selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home',
            hostAccountAgent: { accountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' } }),
          read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
        },
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: rpc.invokeLocal.bind(rpc) },
      }, plugins: [{ manifest: plugin.manifest, replaceExisting: true, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate: plugin.activate }) }] });
    let bridge: ExecutionRunHostBridge | undefined;
    try {
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog();
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-original-root', binding: {
          accountId: actorAccountId, custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
          accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: machineAdmission.installationId,
          actionId: 'review.start', requestId: 'scm-requester-root', requestEnvelopeDigest: 'a'.repeat(43),
          target: { kind: 'machine', machineId: 'machine' },
        } });
      // Only original ingress can retain this proof. JSON-shaped root data is
      // deliberately not enough, and retirement must refuse the next child.
      const authorization = control === 'root-unverified' ? root : retainVerifiedExternalActionRequester({
        isCurrent: async () => control !== 'root-stale', authorization: root });
      const ingress: RpcHandlerContext = { signal: new AbortController().signal,
        ...(rootOnly ? { callerInputAuthorization: authorization, localActionContext: {
          authority: 'account_automation', externalActionExecutionAuthorization: authorization,
        } } : { machineAdmission }),
        verifyMachineAdmissionCurrent: async () => true, callerAuthority: rootOnly ? 'account_automation' : 'present_user' };
      bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: repository.rootPath, machineId: 'machine',
        happyHomeDir: directory, runtimeAccountId: 'owner', resolveAccountSettings: async () => ({}),
        sendAcp: async () => {}, resolveExecutionRunProfileCatalog: () => ({ profileCatalog, engineRegistry }) });
      const started = await bridge.start({ sessionId: null, intent: 'agent',
        backendTarget: { kind: 'agent', identity: { pluginId: plugin.manifest.id, localId: 'reviewer' } },
        instructions: 'Read checkout facts', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', requesterWorkAttributionV1: {
          serverId: 'home', accountId: actorAccountId, machineId: 'machine', installationId: machineAdmission.installationId },
        projectLaunchContext: { ingress, isCurrent: () => true, resolveRuntime: async () => null },
      });
      await Promise.race([responseReady.promise, bridge.waitForTerminal(started.runId)]);
      if (control === 'owner' || control === 'root-owner') {
        expect(response, JSON.stringify(bridge.getPublic(started.runId))).toMatchObject({ success: true,
          snapshot: { repo: { isRepo: true, rootPath: repository.rootPath } } });
        expect(verifiedActors).toEqual(rootOnly ? [] : ['owner']);
      } else {
        expect(response).toBeUndefined();
        expect(failure).toMatchObject({ code: control === 'root-unverified' ? 'not_authenticated' : 'RPC_FORBIDDEN' });
        expect(verifiedActors).toEqual(guest && !rootOnly ? ['guest'] : []);
      }
    } finally {
      await bridge?.dispose(); await fixture.dispose(); vi.restoreAllMocks();
      await Promise.all([rm(repository.rootPath, { recursive: true, force: true }), rm(directory, { recursive: true, force: true })]);
    }
  }));

it.each(['owner', 'guest', 'foreign-installation'] as const)(
  'does not open a non-isolated local route with a retained %s root', async control => {
    const method = RPC_METHODS.CAPABILITIES_DESCRIBE;
    expect(resolveMachineRpcRoutePolicy(method).requesterExecutionIsolationRequired).not.toBe(true);
    let effects = 0;
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: () => { throw new Error('This route has no requester isolation admission'); } });
    rpc.registerHandler(method, () => { effects++; return { ok: true }; });
    const authorization = retainVerifiedExternalActionRequester({ isCurrent: async () => true,
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-original-root', binding: {
        accountId: control === 'guest' ? 'guest' : 'owner', custodianAccountId: 'owner',
        authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: 'home',
        machineId: 'machine', installationId: control === 'foreign-installation' ? 'foreign' : 'installation',
        actionId: 'review.start', requestId: 'scm-requester-root', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'machine' },
      } }) });
    const transport = createCliMachineActionTransport({ credentials: { token, encryption: null },
      serverId: 'home', serverIdentityId: 'home',
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: rpc.invokeLocal.bind(rpc) } });
    await expect.soft(transport.callMachineAction({ machineId: 'machine', method, request: {},
      context: { authority: 'account_automation', externalActionExecutionAuthorization: authorization } }))
      .rejects.toMatchObject({ code: 'not_authenticated' });
    expect.soft(await authorizeMachineRpcRequest({ method: `machine:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`, params: {},
      localActionContext: { authority: 'account_automation', externalActionExecutionAuthorization: authorization } }))
      .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
    expect(effects).toBe(0);
  });
