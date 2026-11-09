import { createServer } from 'node:http';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { UserMessageSchema } from '@/api/types';
import { SessionInputAdmissionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resolveProviderConnectionForMachine } from '@/providers/registry/resolve';
import type { ExecutionRunAdmittedPendingInputV1, ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';

/** Exercise the real Undici control client against the fixture's HTTP router.
 * The router still enters the real daemon app and its authorization handlers. */
export async function createSnapshotDaemonHttpListener() {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const headers = new Headers();
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
      const reply = await globalThis.fetch(`http://127.0.0.1:${port}${request.url}`, {
        method: request.method, headers, body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(reply.status, Object.fromEntries(reply.headers));
      response.end(await reply.text());
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Snapshot HTTP listener has no TCP address');
  const port = address.port;
  return { port, stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/** Substitute only the parent Session's persisted Pending transport. Host drain,
 * exact-input acceptance, native delivery and snapshot custody remain real. */
export function createSnapshotSessionPendingTransport(authorAccountId = 'snapshot-account'): Pick<ApiSessionClient,
  'enqueueSessionUserMessageWithDisposition' | 'bindExecutionRunPendingInput'> {
  const queued = new Map<string, ExecutionRunAdmittedPendingInputV1[]>();
  const bindings = new Map<string, ExecutionRunPendingInputBinding>();
  const accepted = new Map<string, Set<string>>();
  const offer = (binding: ExecutionRunPendingInputBinding) => {
    if (!binding.isCurrent()) return;
    const inputs = queued.get(binding.recipient.runId) ?? [];
    while (inputs.length) {
      if (!binding.consume(inputs[0]!)) break;
      inputs.shift();
    }
    binding.wake?.();
  };
  return {
    enqueueSessionUserMessageWithDisposition: async input => {
      if (input.recipient?.kind !== 'execution_run') throw new Error('Snapshot Pending fixture requires an exact Run recipient');
      const runId = input.recipient.runId;
      const inputs = queued.get(runId) ?? [];
      inputs.push({ ...UserMessageSchema.parse({ role: 'user', content: { type: 'text', text: input.text },
        localId: input.localId, ...(input.meta ? { meta: input.meta } : {}) }),
        authorAccountId, inputAdmissionReceipt: null, pendingProviderAction: 'send' });
      queued.set(runId, inputs);
      const binding = bindings.get(runId);
      if (binding) offer(binding);
      return SessionInputAdmissionResultV1Schema.parse({ status: 'accepted', localId: input.localId });
    },
    bindExecutionRunPendingInput: binding => {
      const runId = binding.recipient.runId;
      bindings.set(runId, binding);
      const acceptedIds = new Set<string>();
      accepted.set(runId, acceptedIds);
      offer(binding);
      return {
        getMetadataSnapshot: binding.getMetadataSnapshot,
        waitForMetadataUpdate: async () => false,
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingProviderInputCustodyBeforeMaterialization: async () => binding.isCurrent(),
        materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' }),
        observeProviderInputSettlement: async outcome => {
          if (!binding.isCurrent()) return false;
          if (outcome.kind === 'accepted') acceptedIds.add(outcome.localId);
          return true;
        },
        readDurableProviderInputAcceptanceV1: async localId => binding.isCurrent() && accepted.get(runId)?.has(localId) ? 'accepted' : 'unknown',
        dispose: () => { if (bindings.get(runId) === binding) bindings.delete(runId); },
      };
    },
  };
}

/** Native Agent is the external boundary; source custody, activation and leases stay real. */
export async function createSessionRunSnapshotFixture(happyHomeDir: string) {
  const pluginId = 'acme.snapshot';
  const controller = createPluginReloadController({ happyHomeDir });
  const declaration = (id: string) => ({ id, title: id, runtime: { kind: 'custom' }, primary: 'sessions',
    cli: { executable: { binaryName: `happier-snapshot-${id}`, sourcePreference: 'system-first',
      acceptsJavaScriptFileOverride: true, knownUserBinDirSuffixes: null },
      install: { manual: { kind: 'none' } }, auth: { support: 'unsupported', loginLaunches: [] } },
    catalog: { agentCliSystemTool: { toolId: 'snapshot-native-cli' } },
    capabilities: { tools: { delivery: 'native_mcp' },
      sessions: { open: ['create'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny' },
      structuredOutput: { formats: ['json'] } },
    providerRequirements: { acceptsProtocols: ['openai-responses'], required: { streaming: true },
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['SNAPSHOT_PROVIDER_MODEL'] },
      materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: false } });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir, controller,
    plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId,
      contributes: { agents: [declaration('parent'), declaration('child')],
        systemTools: [{ id: 'snapshot-native-cli', title: 'Snapshot native CLI', executableNames: ['happier-snapshot-uninstalled'] }],
        providers: ['models', 'unverified-models'].map(id => ({ v: 1, id, name: 'Snapshot models', kind: 'cloud',
          endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://1.1.1.1/v1',
            capabilities: { streaming: 'supported', toolRoundTrips: 'supported', reasoningControls: 'supported', statefulResponses: 'supported' } }],
          catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'snapshot-provider-model', name: 'Snapshot model' }] },
          compatibilityOverrides: ['parent', 'child'].map(agent => ({ agentTargetKey: `agent:${pluginId}/${agent}`, protocol: 'openai-responses',
            status: id === 'models' ? 'verified' : 'experimental', reason: 'Controlled native Agent boundary',
            evidence: { sourceUrls: ['https://example.test/contract'], verifiedAt: '2026-10-16' } })),
        })),
        resources: [{ id: 'delegate-text', kind: 'prompt', path: './delegate.md', contentType: 'text/markdown' }],
        promptAssets: [{ id: 'delegate-prompt', kind: 'systemPrompt', resource: 'delegate-text',
          target: { kind: 'agent', agent: 'parent' } }],
        executionRunProfiles: [{ id: 'captured-delegate', intent: 'delegate', title: 'Captured delegate',
          promptAsset: 'delegate-prompt', compatibleAgents: ['parent'],
          defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' } },
          { id: 'captured-review', intent: 'review', title: 'Captured review',
            promptAsset: 'delegate-prompt', compatibleAgents: ['parent'],
            defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' },
            actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }] },
          { id: 'captured-retained-review', intent: 'review', title: 'Captured retained review',
            promptAsset: 'delegate-prompt', compatibleAgents: ['parent'],
            defaults: { retention: 'resumable', runClass: 'longLived', io: 'streaming' } }],
      } }),
      files: { 'delegate.md': 'Use the daemon-admitted profile instructions.', 'factory.mjs': `
        import { appendFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export function createRuntime({ agent }) {
          return { sessions: { async open(request, { services }) {
            let emit;
            let sequence = 0;
            let nativeChild;
            const nativeCli = await services.exec.systemTools.resolve({ toolId: 'snapshot-native-cli',
              purpose: 'Prepare native child skills', cwd: request.cwd });
            await appendFile(join(request.cwd, 'native-opens.jsonl'), JSON.stringify({
              agentId: agent.id, modelId: request.configuration?.model?.value ?? null,
              nativeCliPath: nativeCli.executablePath,
              sessionId: request.sessionId,
              providerConnectionId: request.providerBinding?.connectionId ?? null,
              materializedProviderModel: request.launchEnvironment?.values?.SNAPSHOT_PROVIDER_MODEL ?? null,
            }) + '\\n');
            return { send: async input => {
              if (input.input.text.includes('retained-snapshot-turn-1')) {
                nativeChild ??= await services.exec.spawn({ executable: nativeCli.executable,
                  args: ['--hold'], cwd: { root: 'workspace', relativePath: '' } });
              }
              await appendFile(join(request.cwd, 'native-inputs.jsonl'), JSON.stringify({
                agentId: agent.id, text: input.input.text,
              }) + '\\n');
              const review = input.input.text.includes('review-host-action-fixture');
              const secondOpinion = input.input.text.includes('second-opinion-role-fixture');
              const approvalReviewer = input.input.text.includes('Assess this pending tool request') || input.input.text.includes('pwd');
              if ((review || secondOpinion || approvalReviewer || input.input.text.includes('retained-snapshot-turn')) && input.delivery.kind === 'newTurn') {
                const event = body => emit({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now(), ...body });
                event({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                event({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                event({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: approvalReviewer
                  ? JSON.stringify({ decision: 'allow_once', reason: 'Read-only within the task.' }) : secondOpinion
                  ? JSON.stringify({ verdict: 'agree', confidence: 1, risks: [], missingEvidence: [], nextStep: 'Continue.' }) : review
                  ? JSON.stringify({ summary: 'Review fixture', findings: [], proposedComments: [{
                    findingId: 'snapshot-finding', body: 'Use the current daemon authority.',
                    anchor: { kind: 'file', filePath: 'native-opens.jsonl' },
                  }] }) : 'Retained reply' });
                event({ kind: 'turn-complete', turnId: input.delivery.turnId });
              }
              return { status: 'admitted' };
            },
              cancel: async request => ({ status: 'requested', turnId: request.turnId }),
              watch: listener => { emit = listener; return { dispose() {} }; }, dispose: async () => {} };
          } } };
        }
      `, 'daemon.mjs': `
        import { createRuntime } from './factory.mjs';
        export function activate(api) {
          for (const id of ['parent', 'child']) api.agents.register(id, createRuntime, {
            sessionRunnerFactory: { module: './factory.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: { probeModels: () => [
              { id: 'snapshot-native-review', name: 'Snapshot Review' },
              { id: 'snapshot-native-unknown', name: 'Snapshot Unknown', capabilities: { structuredOutput: 'unknown' } },
            ] },
            providerBinding: { v: 1, adapterVersion: 1,
              prepare() { return { v: 1, materialization: 'spawnEnv' }; },
              materialize(input) { return { v: 1, kind: 'spawnEnv', env: [
                { name: 'SNAPSHOT_PROVIDER_MODEL', value: input.binding.selection.model.id, source: 'provider' }
              ] }; },
            },
          });
        }
      ` } }],
    runtimeOptions: { pluginIds: [pluginId] },
  });
  const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [['snapshot-provider', 'models'], ['snapshot-unverified-provider', 'unverified-models']].map(([id, localId]) => ({
      v: 1, id, source: { kind: 'contribution', contributionKey: `${pluginId}/${localId}` },
      role: 'named', displayName: 'Snapshot Provider', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })) });
  const accountGrants = initial.connections.map(connection => {
    const resolved = resolveProviderConnectionForMachine({ connectionId: connection.id, machineId: 'snapshot-machine',
      providerSettings: initial, registry: fixture.registry.contributes, dnsEvidenceByEndpointUrl: new Map([['https://1.1.1.1/v1', ['1.1.1.1']]]) });
    if (resolved.status !== 'resolved') throw new Error('Expected admitted snapshot Provider');
    return { v: 1, connectionId: connection.id, connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 };
  });
  const providerSettings = ProviderSettingsV1Schema.parse({ ...initial, accountGrants });
  return { ...fixture, providerCatalog: splitProviderSettingsV1(providerSettings).catalog,
    async dispose() {
      try { await fixture.dispose(); }
      finally { await controller.shutdown(); }
    },
  };
}
