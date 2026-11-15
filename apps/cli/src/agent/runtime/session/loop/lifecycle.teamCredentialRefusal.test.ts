import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { createCodexAppServerRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import { createLifecycleParams } from './lifecycle.testkit';
import { runSessionLoopLifecycle } from './lifecycle';
import fastify from 'fastify';
import { writeProviderBrokerApplicationFailure } from '@/providers/broker/providerBrokerApplicationServer';
import { createSessionBrokerApplicationEvidence } from '@/providers/broker/sessionBrokerApplicationEvidence';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';

it.each(['resource_forbidden', 'connected_service_credential_reconnect_required'] as const)(
  'keeps a real Codex %s enrichment in durable failure history', async reasonCode => {
  onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
  const codexHome = await mkdtemp(join(tmpdir(), 'fix-c214-codex-'));
  onTestFinished(() => rm(codexHome, { recursive: true, force: true }));
  const base = createLifecycleParams({ policyAgentId: 'codex' });
  Object.assign(base.session, { requiresDurableTurnCompletionMarker: true });
  const evidence = createSessionBrokerApplicationEvidence({ sessionId: 'session-1', pid: process.pid,
    readActiveTurnId: () => 'withdrawn-turn', isCurrent: () => true });
  // Drive the actual HTTP refusal producer and daemon turn-evidence owner;
  // the bridge below is the daemon RPC boundary, not a fabricated denial DTO.
  const broker = fastify();
  broker.get('/refusal', (_request, reply) => writeProviderBrokerApplicationFailure(reply,
    { ok: false, reasonCode }, 'withdrawn-resource'));
  onTestFinished(() => broker.close());
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  // Only the native app-server transport is replaced. Its codec, runtime,
  // native adapter, host lifecycle, enrichment and history writer stay real.
  const core = createCodexAppServerRuntime({ directory: '/tmp/project', happierSessionId: 'session-1',
    processEnv: { CODEX_HOME: codexHome },
    host: { baseProcessEnv: {}, logger: { debug() {}, warn() {} }, createClient: async () => ({
      launchFeatures: { realtimeConversationAdvertised: false },
      request: async (method): Promise<ProtocolJsonValue> => method === 'thread/start' ? { thread: { id: 'thread-1' } }
        : method === 'turn/start' ? { turn: { id: 'native-turn-1' } } : {},
      notify: async () => {}, registerRequestHandler: () => () => {}, onNativeEvent: () => () => {}, onExit: () => () => {}, dispose: async () => {},
      registerNotificationHandler: (method, handler) => { handlers.set(method, handler); return () => { handlers.delete(method); }; },
    }) },
  });
  onTestFinished(() => core.dispose());
  const native = createCodexNativeAppServerSessionRuntime(core, 'session-1');
  const declaration = readAgentCatalogSnapshot().agentDefinitionsById.get('codex');
  if (!declaration?.richDefinition || !declaration.pluginId) throw new Error('Missing Codex declaration');
  const scope = new AbortController();
  const services = createUnavailablePluginServices();
  const contextFixture = createAcpSessionRuntimeContextFixture({ agent: declaration.richDefinition.definition,
    pluginId: declaration.pluginId, sessionId: 'session-1', directory: codexHome, signal: scope.signal,
    session: base.session, services,
    protocols: createPublicAcpRuntimeProtocols({ pluginId: declaration.pluginId, agentId: 'codex',
      signal: scope.signal, isCurrent: () => !scope.signal.aborted, services }),
  });
  onTestFinished(async () => { scope.abort(); await contextFixture.dispose(); });
  const runtime = createNativeAgentSessionOperations(native, 'session-1', undefined, undefined, undefined, undefined, undefined, {
    context: contextFixture.context, cwd: codexHome, connectedAccounts: [],
    capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
    cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
  });
  let evidenceReads = 0;
  await runSessionLoopLifecycle({ ...base, runtime, hookRuntime: runtime,
    deps: { ...base.deps,
      readTeamCredentialFailureEvidence: async turnId => {
        expect(turnId).toBe('withdrawn-turn');
        evidenceReads++;
        return evidence.readFailureEvidence(turnId);
      },
      runPermissionModePromptLoopFn: async () => {
        runtime.beginTurnLifecycle();
        await runtime.sendTurnPrompt('Continue', { localId: 'withdrawn-input', turnId: 'withdrawn-turn' });
        const response = await broker.inject({ method: 'GET', url: '/refusal' });
        expect(response.statusCode).toBe(403);
        const refusal = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: { body: response.json() } });
        expect(refusal.teamCredential?.reasonCode).toBe(reasonCode);
        evidence.beginRequest()(refusal.teamCredential ?? null);
        const completion = runtime.waitForTurnCompletion().then(() => null, (error: unknown) => error);
        const completed = handlers.get('turn/completed');
        if (!completed) throw new Error('Native completion handler missing');
        await completed({ threadId: 'thread-1', turn: { id: 'native-turn-1', status: 'failed',
          error: { message: reasonCode === 'resource_forbidden' ? 'native transport closed'
            : 'API Error: 400 {"error":{"code":"model_not_found"}}', codex_error_info: 'other' } } });
        expect(await completion).toBeInstanceOf(Error);
      },
    },
  });
  const mutations = vi.mocked(base.session.enqueueSessionTurnMutation!).mock.calls
    .map(([mutation]) => SessionTurnMutationV1Schema.parse(mutation));
  const failure = mutations.find(mutation => mutation.action === 'fail');
  if (!failure || failure.action !== 'fail') throw new Error('Missing durable failed turn');
  expect(failure.issue).toMatchObject({ source: 'team_credential',
    teamCredential: { v: 1, resourceId: 'withdrawn-resource', reasonCode } });
  const history = vi.mocked(base.session.enqueueAgentMessageCommitted!).mock.calls
    .filter(([, body]) => body.type === 'message');
  expect(history).toHaveLength(1);
  expect.soft(history[0]).toMatchObject(['codex', { type: 'message', message: failure.issue.sanitizedPreview },
    { meta: { runtimeIssueSource: 'team_credential', runtimeIssueCode: reasonCode, runtimeIssueV1: failure.issue } }]);
  const row = history[0];
  if (!row) throw new Error('Missing failure history');
  const normalized = normalizeRawMessage('failed-history', 'failed-history', failure.issue.occurredAt,
    buildAcpAgentMessageEnvelope({ provider: row[0], body: row[1], meta: row[2]?.meta }), { seq: 10 });
  // The actual UI message reader, not only the writer's unparsed metadata bag.
  expect.soft(normalized?.meta).toMatchObject({ source: 'runtime', runtimeIssueSource: 'team_credential',
    runtimeIssueCode: reasonCode, runtimeIssueV1: failure.issue });
  expect(vi.mocked(base.session.enqueueAgentMessageCommitted!).mock.calls
    .filter(([, body]) => body.type === 'turn_failed')).toHaveLength(1);
  expect(evidenceReads).toBe(1);
});
