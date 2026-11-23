import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildQualifiedPluginContributionKey, type PluginAgentContributionV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import * as persistence from '@/persistence';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerMachineSessionGoalRpcHandlers } from '@/api/machine/rpcHandlers.sessionGoals';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createDaemonSessionMutationCustody } from '@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { bindInactiveSessionControlLaunchScope } from '@/daemon/spawn/inactiveSessionControlLaunchScope';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  resolveInactiveSessionCatalogControls,
  resolveInactiveSessionGoalControls,
  resolveInactiveSessionUsageLimitRecoveryControls,
} from './sessionControlAdapters';

const PLUGIN_ID = 'acme.external-controls';
const LOCAL_AGENT_ID = 'assistant';
const AGENT_ID = buildQualifiedPluginContributionKey({ pluginId: PLUGIN_ID, localId: LOCAL_AGENT_ID });

describe('inactive session control adapters for an externally contributed Agent', () => {
  let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  let directory: string | null = null;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-external-inactive-controls-'));
    const pluginRoot = join(directory, 'plugin');
    const happyHomeDir = join(directory, 'home');
    const agent = {
      id: LOCAL_AGENT_ID,
      title: 'External controls Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'], delivery: ['newTurn'], cancel: true,
          goals: {
            inactive: { get: true, set: { fields: ['objective'] }, clear: true },
            source: 'goals',
          },
          catalog: { inactive: ['skills', 'vendorPlugins'] },
          usageLimitRecovery: { inactive: ['checkNow'] },
          workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
        },
      },
    } satisfies PluginAgentContributionV2;
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(
      createPluginManifestV2Fixture({ id: PLUGIN_ID, contributes: { agents: [agent] } }),
    ));
    await writeFile(join(pluginRoot, 'runtime.mjs'), [
      "let goal = null; let sequence = 0;",
      "const publishGoal = async context => { await context.goalSource.publish({ sourceSequence: ++sequence, observedAtMs: Date.now(), items: goal ? [{ localId: 'goal', kind: 'goal', origin: 'vendor', title: goal, status: 'paused', updatedAtMs: Date.now() }] : [], primaryLocalId: goal ? 'goal' : null }); return { status: 'applied', revision: String(sequence) }; };",
      "export async function createRuntime() {",
      "  return { sessions: {",
      "    async open() { return { send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'requested' }), watch: () => ({ dispose() {} }), dispose() {} }; },",
      "    goals: { get: publishGoal, set: async (request, context) => { goal = request.objective; return publishGoal(context); }, clear: async context => { goal = null; return publishGoal(context); } },",
      "    catalog: { list: async request => ({ status: 'ok', kind: request.kind, items: [] }) },",
      "    usageLimitRecovery: { run: async () => ({ status: 'ready' }) },",
      "  } };",
      "}",
    ].join('\n'));
    await writeFile(join(pluginRoot, 'daemon.mjs'), [
      "import { createRuntime } from './runtime.mjs';",
      "export function activate(api) {",
      "  api.agents.register('" + LOCAL_AGENT_ID + "', createRuntime, { sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 } });",
      "}",
    ].join('\n'));
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId: PLUGIN_ID, manifestVersion: '1.0.0' });
    fixture = await createAdmittedPluginRuntimeFixture({
      happyHomeDir,
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: [PLUGIN_ID] },
    });
  });

  afterAll(async () => {
    try {
      await fixture?.dispose();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads the declared capabilities of an Agent only the current runtime registry knows about', async () => {
    await expect(resolveInactiveSessionGoalControls(AGENT_ID)).resolves.not.toBeNull();
    await expect(resolveInactiveSessionCatalogControls(AGENT_ID)).resolves.not.toBeNull();
    await expect(
      resolveInactiveSessionUsageLimitRecoveryControls(AGENT_ID),
    ).resolves.not.toBeNull();
  });

  it('still refuses an Agent that no registry generation declares', async () => {
    await expect(resolveInactiveSessionGoalControls('missing.agent')).resolves.toBeNull();
    await expect(resolveInactiveSessionCatalogControls('missing.agent')).resolves.toBeNull();
    await expect(
      resolveInactiveSessionUsageLimitRecoveryControls('missing.agent'),
    ).resolves.toBeNull();
  });

  it('routes same-Machine root Goal Set/Get/Clear through registered daemon custody and commits only effective originals', async () => {
    const activation = await fixture!.registry.activateContributionsOnDemand([{ pluginId: PLUGIN_ID, family: 'agents', localId: LOCAL_AGENT_ID }]);
    expect(fixture!.registry.agentRuntimesByAgentId.has(AGENT_ID), JSON.stringify(activation)).toBe(true);
    const credentials = { token: 'goal-token', encryption: null };
    const sessionId = 'c123456789012345678901234';
    const tuple = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { machineId: 'goal-machine', path: '/repo', runtimeDescriptorV1: { v: 1, agentId: AGENT_ID, agent: {} } }, agentState: null });
    const row = createSessionRecordFixture({ id: sessionId, active: false, machineId: 'goal-machine', encryptionMode: 'plain',
      metadataLayoutVersion: 1, metadata: tuple.sharedMetadata.ciphertext, ownerMetadata: tuple.ownerMetadata,
      metadataVersion: 1, agentState: tuple.agentState, agentStateVersion: 1, share: null });
    const originals: unknown[] = [];
    // Only persisted credentials, Home HTTP and the Machine transport are replaced.
    // Catalog admission, native adapter, router, RPC registration, metadata CAS,
    // comparator, durable journal and strict transcript consumer remain real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    await updateMachineRegistration(() => ({ machineId: 'goal-machine' }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner') throw new Error('Expected owner tuple patch');
      row.metadata = patch.sharedMetadata.ciphertext;
      row.ownerMetadata = patch.ownerMetadata;
      row.metadataVersion += 1;
      if (patch.agentState) { row.agentState = patch.agentState.ciphertext; row.agentStateVersion = (row.agentStateVersion ?? 0) + 1; }
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (!String(url).endsWith(`/v2/sessions/${sessionId}/messages`)) throw new Error(`Unexpected HTTP write: ${url}`);
      const request = body as { localId: string; content: unknown };
      const content = SessionStoredMessageContentSchema.parse(request.content);
      if (content.t !== 'plain') throw new Error('Expected plain original');
      originals.push(TranscriptRawRecordV1Schema.parse(content.v));
      return { status: 200, data: { didWrite: true, message: { id: `message-${originals.length}`, localId: request.localId,
        seq: originals.length, createdAt: 1, updatedAt: 1, content } } };
    });
    // The daemon's admitted launch owner is the process boundary; this external Agent selects no Account,
    // so the ordinary native environment owner stays real beneath it.
    const releaseLaunchScope = bindInactiveSessionControlLaunchScope(async input => {
      const result = await resolveSpawnChildEnvironment({ options: { directory: input.adapterParams.cwd ?? '/repo' },
        profileEnvironmentVariables: {}, processEnv: {}, daemonSpawnHooks: null, logDebug() {}, logInfo() {}, logWarn() {} });
      if (!result.ok) throw new Error('Native fixture scope unavailable');
      return { environment: result.extraEnvForChild, connectedAccounts: [], async assertCurrent() {}, async dispose() {} };
    });
    const custody = createDaemonSessionMutationCustody({ credentials });
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    registerMachineSessionGoalRpcHandlers({ rpcHandlerManager: {
      registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
        handlers.set(method, async request => handler(request as TRequest));
      },
    } satisfies RpcHandlerRegistrar, deps: { currentMachineId: 'goal-machine', stageWorkStateMutation: input => custody.stageWorkState(input) } });
    const relayed: string[] = [];
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'goal-machine', invoke: async (method, request) => {
        relayed.push(method);
        const handler = handlers.get(method);
        if (!handler) throw new Error(`Missing registered Goal handler: ${method}`);
        return handler(request);
      } } });
    try {
      const set = () => deps.sessionGoalSet!({ sessionId, objective: 'Private inactive objective', resumeInactiveWithInitialGoal: false });
      const initial = await set();
      expect(initial).toMatchObject({ status: 'applied', workState: { items: [expect.objectContaining({ title: 'Private inactive objective', origin: 'vendor' })] } });
      expect(SessionWorkStateGetResponseV1Schema.parse(initial).workState?.items).toMatchObject([{ title: 'Private inactive objective' }]);
      await vi.waitFor(() => expect(originals).toHaveLength(1));
      expect(SessionWorkStateGetResponseV1Schema.parse(await deps.sessionGoalGet!({ sessionId })).workState?.items).toMatchObject([{ title: 'Private inactive objective' }]);
      await set();
      expect(originals).toHaveLength(1);
      expect(SessionWorkStateGetResponseV1Schema.parse(await deps.sessionGoalClear!({ sessionId })).workState?.items).toEqual([]);
      await vi.waitFor(() => expect(originals).toHaveLength(2));
      await deps.sessionGoalClear!({ sessionId });
      expect(originals).toHaveLength(2);
      expect(relayed).toEqual([RPC_METHODS.DAEMON_SESSION_GOAL_SET, RPC_METHODS.DAEMON_SESSION_GOAL_GET,
        RPC_METHODS.DAEMON_SESSION_GOAL_SET, RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR, RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR]);
      for (const original of originals) expect(original).toEqual({ role: 'agent', content: { type: 'event',
        id: expect.stringMatching(/^goal-changed:/), data: { type: 'goal-changed' } } });
      expect(row.active).toBe(false);
    } finally { releaseLaunchScope(); await custody.close(); vi.restoreAllMocks(); }
  });
});
