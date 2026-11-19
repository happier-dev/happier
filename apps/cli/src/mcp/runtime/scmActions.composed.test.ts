import axios from 'axios';
import nacl from 'tweetnacl';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse, createActionExecutor, FeaturesResponseSchema, ScmDiffFileResponseSchema } from '@happier-dev/protocol';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createDeferred } from '@/testkit/async/deferred';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { createTestRpcManager } from '@/scm/rpc/__tests__/testRpcHarness';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { configuration } from '@/configuration';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createExecutionRunOccurrenceWitnessRegistry } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createTargetedActionRpcRequestV1, TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

const processIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));

// The daemon catalog and Machine RPC are process/network boundaries. Everything
// beneath them, including physical plugin admission and registered SCM, is real.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const sessionId = 'c123456789012345678901234';
const machineId = 'scm-target-machine';
const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'fixture-account', tokenEpoch: 0,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
const backendId = 'acme.scm/preferred';

async function withScmDaemon(run: (fixture: Readonly<{
  parent: string; cwd: string; receiver: ReturnType<typeof createTestRpcManager>;
}>) => Promise<void>) {
  await withTempDir('scm-action-route-', async directory => {
    const parent = join(directory, 'parent');
    const cwd = join(directory, 'run');
    await mkdir(parent); await mkdir(cwd);
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
      manifest: { schemaVersion: 2, id: 'acme.scm', version: '1.0.0', displayName: 'SCM route fixture',
        engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [], optional: [] }, contributes: { scmBackends: ['default', 'preferred'].map(id => ({
          id, title: id, kind: 'acme', capabilities: ['detect', 'diff'],
        })) } },
      files: { 'daemon.mjs': `export function activate(api) {
        for (const id of ['default', 'preferred']) api.scm.registerBackend(id, {
          runtime: { repoModes: ['.git'], commands: [], capabilities: {
            detection: { repository: { support: 'supported' } }, read: { diffFile: { support: 'supported' } },
            changeSet: { model: 'working-copy', diffAreas: ['pending'] }, commit: {}, remote: {}, branch: {},
            worktree: {}, lifecycle: {}, hosting: {}, checkpoints: {}, workspaceIntegration: {}, tooling: {}, freshness: {} } },
          handlers: { detection: { detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }) },
            read: { diffFile: async ({ context, request }) => ({ success: true, diff: id + ':' + context.cwd + ':' + request.path }) } }
        });
      }` },
    }] });
    try {
      const registry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: runtime.registry });
      const receiver = createTestRpcManager({ workingDirectory: parent, machineId, registry,
        accessPolicy: { kind: 'restrictedRoots', roots: [cwd, parent] } });
      // This controller is the daemon fixture's own owner, never the runner's singleton.
      await expect(acquireAuthoritativePluginRuntimeRegistryLease()).rejects.toMatchObject({ code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE' });
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data:
        String(url).endsWith('/v1/account/encryption/currentness')
          ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
          : { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', machineId,
              metadata: JSON.stringify({ path: parent, machineId }), share: null }) },
      }));
      await run({ parent, cwd, receiver });
    } finally { await runtime.dispose(); }
  });
}

describe('Session SCM daemon placement', () => {
  it.each([{ child: false, restricted: false }, { child: true, restricted: false }, { child: true, restricted: true }])(
    'composes real MCP and registered admitted SCM with no runner registry ($child/$restricted)', async ({ child, restricted }) => {
    await withScmDaemon(async ({ parent, cwd, receiver }) => {
      vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
      const machineCalls: Parameters<typeof machineRpc.callExactMachineRpc>[0][] = [];
      const receivedInputs: unknown[] = [];
      const invoke: typeof machineRpc.callExactMachineRpc = async request => {
        machineCalls.push(request);
        if (request.externalAction?.context.externalActionExecutionAuthorization) {
          const input = TargetedActionRpcRequestV1Schema.parse(request.request).input;
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SCM requires object input');
          const semanticInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'outcomeVersion'));
          receivedInputs.push(semanticInput);
        }
        return receiver.call(request.method, request.request, request.authorization);
      };
      vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(invoke);
      vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(invoke);
      const lifetime = new AbortController();
      const witness = { turnId: 'scm-turn', inputId: 'scm-input', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const } };
      // Native controller identity is the provider boundary; current Run custody is real.
      const controller = { kind: 'backend', controllerOccurrenceId: 'scm-occurrence' } as Extract<ExecutionRunController, { kind: 'backend' }>;
      const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['scm-run', controller]]));
      const occurrence = registry.register({ runId: 'scm-run', sidechainId: 'scm-sidechain', controller,
        runtimeLifetimeSignal: lifetime.signal, readActiveTurnAdmissionWitness: () => witness });
      const settings = accountSettingsParse({});
      const proofInputs: unknown[] = [];
      let proofBoundaryFailure: unknown;
      let authority: Parameters<typeof removeAgentRuntimeDaemonServiceAuthorityIfOwned>[0] | undefined;
      if (restricted) {
        const command = 'node /runtime/.runner-snapshots/scm-route/dist/index.mjs';
        const runner = { pid: process.pid, processStartTimeMs: 12345, processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:scm-route' };
        processIdentity.mockResolvedValue({ pid: process.pid, processStartTimeMs: runner.processStartTimeMs, command });
        const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
        const binding = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing, path, sessionId, runner,
          retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.agent', pluginVersion: '1.0.0',
            agentId: 'acme.agent/agent', localAgentId: 'agent', sourceCustody: { kind: 'managed',
              immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
            locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' }) };
        await publishAgentRuntimeDaemonServiceAuthority({ ...binding, httpPort: 31001, capability: 'A'.repeat(43) });
        authority = { ...binding, capabilityDigest: hashPrivateBearer('A'.repeat(43)) };
        vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
          try {
          if (new URL(String(url)).pathname === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('scm.diff.file')) {
            expect(body).toEqual({ v: 1 });
            return { status: 200, data: { ok: true } };
          }
          const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
          if (request.envelope.v !== 1) throw new Error('Plain fixture requires a plain Action envelope');
          proofInputs.push(request.envelope.input);
          return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-proof', binding: {
            serverIdentityId: 'srv_scm_fixture', accountId: 'fixture-account', custodianAccountId: 'fixture-account',
            authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', machineId,
            installationId: 'scm-fixture-installation', actionId: 'scm.diff.file', requestId: request.envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
            sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
          } }) };
          } catch (error) { proofBoundaryFailure = error; throw error; }
        });
        const daemon = createDaemonSessionAccountActionExecutor({ machineId, serverId: configuration.activeServerId,
          serverHttpBaseUrl: configuration.serverUrl, token: credentials.token, credentials,
          prepareExternalActionAuthorization: async admission => {
            const target = admission.workflowTarget;
            if (!target) throw new Error('SCM must retain its host-selected workspace');
            const authorization = await prepareExternalActionRequesterAccountAuthorization({ ...admission.operation, target,
              machineId, sourceMachineId: machineId, accountId: 'fixture-account', accountEncryptionMode: 'plain', tokenEpochHint: 0,
              token: credentials.token, serverId: configuration.activeServerId, serverIdentityId: 'srv_scm_fixture',
              serverHttpBaseUrl: configuration.serverUrl, installationId: 'scm-fixture-installation', privateKey: keys.secretKey,
              sessionActionOrigin: admission.sessionActionOrigin, isCurrent: admission.isCallerCurrent, signal: admission.authority.signal });
            return authorization ? { authorization, target } : null;
          },
          createExecutor: () => createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
            sessionId: '', mode: 'plain', ctx: null, externalActionMachineRequestPrivateKey: keys.secretKey,
            externalActionMachineInstallationId: 'scm-fixture-installation' })),
        });
        const actualFetch = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
          if (new URL(url instanceof Request ? url.url : String(url)).port !== '31001') return actualFetch(url, init);
          const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
          if (request.operation.kind !== 'action.execute') throw new Error('Unexpected daemon operation');
          expect(request.operation).toMatchObject({ scmWorkspace: { machineId, directory: cwd },
            executionRun: { runId: 'scm-run', occurrenceId: 'scm-occurrence' } });
          const outcome = await daemon(request.operation, { sessionId, isCurrent: async () => true, signal: lifetime.signal });
          return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
        });
      }
      const client = new Client({ name: 'scm-route-test', version: '1' });
      let binding: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
      try {
      binding = await resolveRunnerMcpServers({
        session: createMutableApiSessionClientFixture({ sessionId, overrides: {
          getServerBinding: () => ({ serverId: configuration.activeServerId, serverUrl: configuration.serverUrl }),
          getCurrentSessionLocation: () => ({ path: parent, machineId }),
          getMetadataSnapshot: () => ({ path: parent, machineId }),
          enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
          getActiveTurnAdmissionWitness: () => witness,
          getActiveTurnPermissionWitness: () => ({ ...witness, workDepth: 0 }),
          getWorkDepth: () => 0,
          getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
            features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
        } }), credentials, accountCredentials: restricted ? null : credentials, accountSettings: settings,
        accountSettingsSnapshot: { source: 'network', settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
          scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), mcpServerCatalog: { status: 'ready', authority: 'active',
            revision: 1, diagnostics: [], catalog: { v: 1, servers: [], bindings: [] } } },
        machineId, directory: parent, env: {},
        ...(child ? { executionRun: { runId: 'scm-run', workDepth: 1, cwd, signal: lifetime.signal,
          isCurrent: () => !lifetime.signal.aborted, getPermissionMode: () => 'read-only' as const,
          readActiveTurnAdmissionWitness: () => witness, readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence } } : {}),
      });
        await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
        const output = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
          actionId: 'scm.diff.file', input: { cwd: '/authored/elsewhere', path: 'arithmetic.js', area: 'pending',
            backendPreference: { kind: 'prefer', backendId } },
        } }));
        const content = output.content.find(block => block.type === 'text');
        if (proofBoundaryFailure) throw proofBoundaryFailure;
        if (restricted) expect(proofInputs, 'Restricted SCM must reach original Home minting').toHaveLength(1);
        if (content?.type !== 'text') throw new Error('Missing SCM MCP response');
        expect(output.isError, content.text).not.toBe(true);
        const response = ScmDiffFileResponseSchema.parse(JSON.parse(content.text));
        expect(response).toMatchObject({ success: true, diff: `preferred:${child ? cwd : parent}:arithmetic.js` });
        if (restricted) expect(proofInputs).toEqual([expect.objectContaining({ cwd })]);
        if (restricted) {
          expect(machineCalls[0]).toMatchObject({ requestId: expect.any(String), externalAction: { effectActionId: 'scm.diff.file',
            context: { runtimeRunId: 'scm-run', runtimeRunOccurrenceId: 'scm-occurrence' } } });
          expect(receivedInputs).toEqual(proofInputs);
        }
        expect(machineCalls).toMatchObject([{ machineId, method: 'scm.diff.file', authorityCeiling: 'account_automation',
          request: { kind: 'targeted_action_rpc', target: { kind: 'machine', machineId, project: { directory: child ? cwd : parent } },
            input: { cwd: child ? cwd : parent, backendPreference: { kind: 'prefer', backendId }, outcomeVersion: 1 } } }]);
      } finally { await client.close(); binding?.happierMcpServer.stop(); occurrence.dispose();
        if (authority) await removeAgentRuntimeDaemonServiceAuthorityIfOwned(authority); }
    });
  });

  it('fails closed when the exact Machine route is misbound', async () => {
    await withScmDaemon(async () => {
      const reject = async () => { throw Object.assign(new Error('Wrong Machine route'), { code: 'machine_not_found' }); };
      const ordinary = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(reject);
      const exact = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(reject);
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId, mode: 'plain', ctx: null }));
      const response = await executor.execute('scm.diff.file', { path: 'arithmetic.js', area: 'pending',
        backendPreference: { kind: 'prefer', backendId } }, { surface: 'cli', defaultSessionId: sessionId });
      // The Machine refusal itself is the outcome (the fixture's sentinel, not
      // product copy): a local fallback would surface the runner's own SCM
      // failure instead, and a retry would call again.
      expect(response).toEqual({ ok: false, errorCode: 'action_failed', error: 'Wrong Machine route' });
      expect(exact).toHaveBeenCalledTimes(1); expect(ordinary).not.toHaveBeenCalled();
    });
  });

  it('executes the admitted built-in Git backend on the receiving Machine', async () => {
    await withTempDir('scm-action-git-route-', async cwd => {
      runScmExecutable(cwd, 'git', ['init']);
      await writeFile(join(cwd, 'untracked.txt'), 'SCM Machine read\n');
      const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
      try {
        const registry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: runtime.registry });
        const receiver = createTestRpcManager({ machineId, workingDirectory: cwd, registry });
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/v1/account/encryption/currentness')
          ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
          : { session: createSessionRecordFixture({ id: sessionId, machineId, encryptionMode: 'plain', metadata: JSON.stringify({ path: cwd }), share: null }) } }));
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(request => receiver.call(request.method, request.request, request.authorization));
        const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null }));
        const result = await executor.execute('scm.diff.file', { path: 'untracked.txt', area: 'pending' }, { surface: 'cli', defaultSessionId: sessionId });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('Missing built-in SCM result');
        expect(ScmDiffFileResponseSchema.parse(result.result)).toMatchObject({ success: true, diff: expect.stringContaining('+SCM Machine read') });
        const nested = join(cwd, 'nested'); await mkdir(nested);
        const status = { cwd, outcomeVersion: 1, operationStateVersion: 1 };
        const target = { kind: 'machine' as const, machineId, project: { machineId, directory: cwd } };
        expect(await receiver.call('scm.status.snapshot', createTargetedActionRpcRequestV1(status, target))).toMatchObject({ success: true });
        expect(await receiver.call('scm.status.snapshot', createTargetedActionRpcRequestV1(status,
          { ...target, project: { machineId, directory: nested } }))).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
      } finally { await runtime.dispose(); }
    });
  });

  it('retains cancellation through the Session-to-Machine hop without local replay', async () => {
    await withScmDaemon(async () => {
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const call = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(request => new Promise((_resolve, reject) => {
        expect(request.signal).toBe(controller.signal);
        request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        entered.resolve();
      }));
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null }));
      const pending = executor.execute('scm.diff.file', { path: 'arithmetic.js' }, { surface: 'cli', defaultSessionId: sessionId, signal: controller.signal });
      await entered.promise; controller.abort();
      expect(await pending).toMatchObject({ ok: false });
      expect(call).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['home', 'machine', 'root'] as const)('denies a mismatched Session %s before Machine dispatch', async mismatch => {
    await withScmDaemon(async ({ cwd }) => {
      const remote = vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new Error('Must not dispatch'));
      const ordinary = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('Must not dispatch'));
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId,
        mode: 'plain', ctx: null,
        ...(mismatch === 'machine' ? { rawSession: { machineId: 'wrong-machine', path: cwd } } : {}),
        ...(mismatch === 'root' ? { scmFilesystemAccessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] } } : {}),
      }));
      const result = await executor.execute('scm.diff.file', { path: 'arithmetic.js' }, {
        surface: 'cli', defaultSessionId: sessionId,
        ...(mismatch === 'home' ? { serverId: 'wrong-home' } : {}),
      });
      expect(result).toMatchObject({ ok: false, errorCode: mismatch === 'home' ? 'server_scope_mismatch'
        : mismatch === 'machine' ? 'scm_action_session_not_local' : 'scm_action_path_denied' });
      expect(remote).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled();
    });
  });

  it('retains the Session workspace restriction at the receiving SCM owner', async () => {
    await withScmDaemon(async ({ parent, cwd, receiver }) => {
      const call = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(request => receiver.call(request.method, request.request, request.authorization));
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId,
        mode: 'plain', ctx: null }));
      const result = await executor.execute('scm.worktree.remove', { worktreePath: cwd, confirmed: true,
        authorizationToken: 'remove-worktree', backendPreference: { kind: 'prefer', backendId } }, {
        surface: 'rpc', authority: 'account_automation', defaultSessionId: sessionId,
        actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { 'scm.worktree.remove': ['rpc'] } },
      });
      // Both paths are Machine-allowed. The receiver refuses because the request
      // carries the Session root, not because a caller-side check stopped it.
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0]?.[0].request).toMatchObject({ target: { kind: 'machine', machineId,
        project: { machineId, directory: parent } } });
      expect(result).toMatchObject({ ok: true, result: { success: false, errorCode: 'INVALID_PATH' } });
    });
  });
});
