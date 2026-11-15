import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { listVoiceActionBlockSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { configuration, reloadConfiguration } from '@/configuration';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createManifestAgentCatalogEntry } from '@/plugins/projection/registry/agentCliMetadata';
import type { NativeAgentSessionInteractionHostBinding } from '@/agent/runtime/registry/engineRegistryTypes';
import { createNativeSessionBoundary, createVoiceSessionRuntimeThroughNativeFactory } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { registerSessionClientRuntimeHandlers } from './registerSessionClientRuntimeHandlers';

// The daemon's HTTP catalog is an external boundary; composition and the Session
// MCP server, credential selection and Action dispatch remain real.
vi.mock('@/daemon/controlClient', async original => ({ ...await original<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); });

it('uses the admitted Voice Run authority for Session discovery, Brief and Stop without Account credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voice-run-actions-'));
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  reloadConfiguration();
  const sessionId = 'voice-carrier';
  const runId = 'voice-run';
  const lifetime = new AbortController();
  const invocation = { caller: { kind: 'host' as const }, surface: 'voice' as const, authority: 'account_automation' as const };
  const witness = { inputId: 'voice-input', turnId: 'voice-turn', userMessageSeq: null, userMessageSeqs: [] };
  const effects: string[] = [];
  const daemon = await createSessionDaemonAuthorityFixture({ sessionId, execute: async operation => {
    expect(operation).toMatchObject({ executionRun: { runId, occurrenceId: 'voice-occurrence' } });
    effects.push(operation.actionId);
    return { ok: true, result: { actionId: operation.actionId } };
  } });
  let host: NativeAgentSessionInteractionHostBinding | undefined;
  const metadata = createTestMetadata({ path: home, machineId: 'voice-machine' });
  const session = createMutableApiSessionClientFixture({ sessionId, metadata, overrides: {
    setExecutionRunWorkerUpdateSource: source => {
      host = Reflect.get(source, 'sessionInteractionHost') as NativeAgentSessionInteractionHostBinding;
    },
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
  } });
  const readOwnerAccountCredentials = vi.fn(async () => null);
  const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Voice owner test]' });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'voice-account' })).toString('base64url')}.signature`;
  const registration = registerSessionClientRuntimeHandlers({
    rpcHandlerManager: session.rpcHandlerManager, token, serverId: configuration.activeServerId,
    sessionRuntimeControls: { readPermissionHandler: () => permissionHandler },
    serverUrl: configuration.apiServerUrl, runtimePrincipalAccountId: 'voice-account', readOwnerAccountCredentials,
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
    metadataPath: home, metadata, sessionId, session, getSessionMetadata: () => metadata,
    enqueueSessionUserMessage: async () => {},
    enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueVoiceAgentTranscriptTurnCommitted: async () => ({ persisted: true, delivered: true }),
    sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
    getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
    persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
  });
  let native: ReturnType<typeof createVoiceSessionRuntimeThroughNativeFactory> | undefined;
  try {
    if (!host?.composeRunToolBinding) throw new Error('Missing production Run tool composer');
    const agentId = 'acme.voice/agent';
    const catalogEntry = createManifestAgentCatalogEntry({ agentId, pluginId: 'acme.voice', provenance: 'external', cli: null,
        definition: PluginAgentContributionV2Schema.parse({ id: 'agent', title: 'Voice', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { tools: { delivery: 'native_mcp' }, sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }),
    });
    const boundary = createNativeSessionBoundary();
    native = createVoiceSessionRuntimeThroughNativeFactory({ runtime: { sessions: { open: boundary.open } },
      catalogEntry, modelId: 'voice-model', capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      runtimeOptions: { backendId: agentId, runId, controllerOccurrenceId: 'voice-occurrence', cwd: home,
        scope: 'session_owned', permissionMode: 'default', sessionInteractionHost: host,
        start: { intent: 'voice_agent', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
        sessionOwnedRunScope: { runId, workDepth: 0, sidechainId: 'voice-sidechain', actionInvocation: invocation,
          publishSupportedSessionReadActions: () => {},
          projectRunTranscriptSession: () => ({ sessionId, requiresDurableTurnCompletionMarker: true,
            updateMetadata: session.updateMetadata.bind(session),
            enqueueAgentMessageCommitted: session.enqueueAgentMessageCommitted.bind(session) }),
          readCurrentRunOccurrence: id => id === runId ? { runId, occurrenceId: 'voice-occurrence', sidechainId: 'voice-sidechain',
            runtimeLifetimeSignal: lifetime.signal, isCurrent: () => true, readActiveTurnAdmissionWitness: () => witness } : null },
      } });
    await native.provisionRuntime({});
    await native.deliverInput(runId, { text: 'Read my Sessions and Brief, then stop the coding Session.' }, { localId: 'voice-input' });
    const credentialReadsAtAdmission = readOwnerAccountCredentials.mock.calls.length;
    if (!native.executeAction) throw new Error('Missing native Voice Action transport');
    const settingsSearch = await native.executeAction('action.spec.search', { query: 'settings' }, 'voice-settings-search');
    expect(settingsSearch, JSON.stringify(settingsSearch)).toMatchObject({ ok: true });
    expect(JSON.stringify(settingsSearch)).toContain('settings.set');
    expect(await native.executeAction('action.spec.get', { id: 'settings.set' }, 'voice-settings-schema')).toMatchObject({ ok: true });
    const specs = listVoiceActionBlockSpecs();
    for (const name of ['listSessions', 'requestVoiceBrief', 'session_stop']) {
      const spec = specs.find(candidate => candidate.bindings?.voiceClientToolName === name);
      if (!spec) throw new Error(`Missing Voice Action ${name}`);
      const result = await native.executeAction(spec.id, name === 'session_stop' ? { sessionId: 'coding-session' } : {}, `voice-${name}`);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(effects).toContain(spec.id);
    }
    expect(readOwnerAccountCredentials.mock.calls.length).toBe(credentialReadsAtAdmission);
  } finally {
    await native?.dispose();
    await registration.disposeExecutionRuns();
    await registration.dispose();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
