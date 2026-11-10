import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '../../../../../ui/sources/dev/testkit/fixtures/featureFixtures';
import { installVitestRnShim } from '../../../../../ui/sources/dev/vitestRnShim';
import { installLocalStorageMock } from '../../../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createNativeSessionBoundary, createVoiceSessionRuntimeThroughNativeFactory } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import { VoiceAgentManager } from './VoiceAgentManager';
import { createPlainV2SessionRecordFixture, createSessionFixture } from '../../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/metadata/systemSessionV1';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildExecutionRunConfiguration } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';

// CLI collection has no native stylesheet runtime; preserve the real UI owners
// beneath their canonical platform boundary.
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('../../../../../ui/sources/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
  const { createExpoUpdatesMock } = await import('../../../../../ui/sources/dev/testkit/mocks/expoUpdates');
  return createExpoUpdatesMock();
});
vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemFileMock } = await import('../../../../../ui/sources/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemFileMock().module;
});
vi.mock('react-native-typography', async () => {
  const { createReactNativeTypographyMock } = await import('../../../../../ui/sources/dev/testkit/mocks/reactNativeTypography');
  return createReactNativeTypographyMock();
});
vi.mock('@shopify/react-native-skia', async () => {
  const { createReactNativeSkiaMock } = await import('../../../../../ui/sources/dev/testkit/mocks/reactNativeSkia');
  return createReactNativeSkiaMock();
});

installVitestRnShim();
const browserStorage = installLocalStorageMock();
afterAll(() => browserStorage.restore());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { createVoiceToolHandlers } = await import('../../../../../ui/sources/voice/tools/handlers');
const { settingsDefaults } = await import('../../../../../ui/sources/sync/domains/settings/settings');
const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('../../../../../ui/sources/voice/session/voiceSessionStore');
afterEach(async () => { resetVoiceSessionStoreForTests(); await home.reset(); });

describe('Voice Manager output through canonical client Action approval', () => {
  it('delivers two native function Actions from one confined Home conversation and refuses the carrier as a target', async () => {
    await home.reset();
    const serverId = await home.addHome({ name: 'Structured Voice Home', serverUrl: 'https://structured-voice.test',
      accountId: 'alice', currentAccount: true });
    const native = createNativeSessionBoundary();
    const manager = new VoiceAgentManager({ createRuntime: options => createVoiceSessionRuntimeThroughNativeFactory({
      runtime: { sessions: { open: request => native.open(request) } }, modelId: 'structured-voice',
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      functionTools: options.functionTools,
      start: options.start,
      configuration: buildExecutionRunConfiguration({ backendTarget: readBackendTargetRefV2(options.backendTarget),
        modelId: options.modelId, permissionMode: options.permissionIntent, updatedAtMs: 1,
        allowedTools: options.start?.allowedTools, unlistedTools: options.start?.unlistedTools,
      }).configuration,
    }) });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      expect(native.opens[0]?.configuration).toMatchObject({ allowedTools: [], unlistedTools: 'deny' });
      const carrier = { serverId, sessionId: 'structured-voice-carrier' };
      const { storage } = await import('../../../../../ui/sources/sync/domains/state/storage');
      const carrierSession = createSessionFixture({ id: carrier.sessionId, serverId,
        metadata: { ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
      });
      storage.getState().applySessions([carrierSession]);
      home.answer(serverId, 'POST /v2/sessions/read-batch', { body: { results: [{ sessionId: carrier.sessionId,
        detail: { status: 200, body: { session: createPlainV2SessionRecordFixture({ id: carrier.sessionId,
          metadata: carrierSession.metadata }) } },
      }] } });
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId,
        voiceSessionBinding: { adapterId: 'local_conversation', controlSessionId: 'voice-global',
          conversationSessionId: carrier.sessionId, conversationSessionAddress: carrier,
          transcriptMode: 'native_session', targetSessionAddress: null, updatedAt: 1 },
      });
      for (const count of [1, 2]) {
        const turn = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'List my Homes' });
        void turn.catch(() => {});
        await native.waitForInputs(count);
        const tool = native.opens[0]?.functionTools?.find(candidate => candidate.name === 'happier_voice_action');
        expect(tool, 'Home carrier must receive the structured Action function').toBeDefined();
        if (!tool) throw new Error('Missing native Voice function');
        const acknowledgement = await tool.call({ t: 'listServers', args: {} });
        expect(acknowledgement).toMatchObject({ status: 'queued' });
        native.complete('');
        const output = await turn;
        expect(output.actions).toEqual([{ t: 'listServers', args: {} }]);
        expect(output.assistantText).toBe('');
        const result = await handlers.listServers!({});
        expect(JSON.parse(result)).toMatchObject({ ok: true });
        expect(result).toContain(serverId);
      }
      const turn = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Create another file' });
      await native.waitForInputs(3);
      await native.opens[0]!.functionTools![0]!.call({ t: 'sendSessionMessage',
        args: { sessionId: carrier.sessionId, message: 'Create another file' } });
      native.complete('');
      const output = await turn;
      const action = output.actions?.[0];
      expect(action).toBeDefined();
      if (!action) throw new Error('Missing structured Session message');
      const refused = JSON.parse(await handlers[action.t]!(action.args));
      expect(refused).toMatchObject({ ok: false, errorCode: 'voice_conversation_target_forbidden' });
    } finally { await manager.dispose(); }
  });

  it('dispatches a Voice-only read through Manager output and the real client handler', async () => {
    await home.reset();
    const serverId = await home.addHome({ name: 'Voice-only read Home', serverUrl: 'https://voice-only-read.test',
      accountId: 'alice', currentAccount: true });
    const native = createNativeSessionBoundary();
    const createRuntime: ConstructorParameters<typeof VoiceAgentManager>[0]['createRuntime'] = options => createVoiceSessionRuntimeThroughNativeFactory({
      runtime: { sessions: { open: request => native.open(request) } }, modelId: 'voice-only-read',
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      functionTools: options.functionTools,
    });
    const manager = new VoiceAgentManager({ createRuntime });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      const turn = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'List my Homes' });
      await native.waitForInputs(1);
      await native.opens[0]!.functionTools![0]!.call({ t: 'listServers', args: {} });
      native.complete('');
      const output = await turn;
      const action = output.actions?.[0];
      expect(action).toMatchObject({ t: 'listServers', args: {} });
      if (!action) throw new Error('Expected Voice-only Action');
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
      const result = await handlers[action.t]!(action.args);
      expect(JSON.parse(result)).toMatchObject({ ok: true });
      expect(result).toContain(serverId);
    } finally { await manager.dispose(); }
  });

  it.each(['read-only', 'narrowed', 'default'] as const)('routes %s output to one spoken confirmation through the real settings Action boundary', async mode => {
    await home.reset();
    const serverId = await home.addHome({ name: 'Voice Action permission', serverUrl: 'https://voice-action-permission.test',
      accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'voice', true)).toBe(true);
    home.answer(serverId, '/v1/features', { body: features });
    let content: Extract<AccountSettingsStoredContentEnvelope, { t: 'plain' }> = {
      t: 'plain', v: { voice: { ...settingsDefaults.voice, canApproveRequests: true } },
    };
    let version = 1;
    home.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content, version } }) });
    home.answer(serverId, 'POST /v2/account/settings', { select: raw => {
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      expect(request.expectedVersion).toBe(version);
      if (!request.content || request.content.t !== 'plain') throw new Error('Expected plain Account fixture');
      content = request.content;
      return { body: { success: true, version: ++version } };
    } });
    // Only external Agent SDK and Home transports are scripted. Native input,
    // Voice parsing, client handlers, Action approval and settings writes stay real.
    const native = createNativeSessionBoundary();
    const createRuntime: ConstructorParameters<typeof VoiceAgentManager>[0]['createRuntime'] = options => createVoiceSessionRuntimeThroughNativeFactory({
      runtime: { sessions: { open: request => native.open(request) } }, modelId: 'voice-permission',
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      functionTools: options.functionTools,
    });
    const manager = new VoiceAgentManager({ createRuntime });
    let readBacks = 0;
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId,
      playHostText: async ({ text }) => {
        expect(text).toBeTruthy();
        expect(version).toBe(1);
        readBacks += 1;
        return { status: 'completed' as const };
      },
    });
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'spoken-manager-call',
      status: 'connected', mode: 'listening', canStop: true });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: mode === 'read-only' ? 'read-only' : 'default',
        idleTtlSeconds: 60, initialContext: '' });
      const action = { t: 'settings_set', args: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } };
      const stream = mode === 'narrowed' ? await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'Use the settings Action', causalPermissionAuthority: {
          kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const,
        },
      }) : null;
      const turn = stream ? null : manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Use the settings Action' });
      const outputPromise = turn?.then(output => output.actions ?? []);
      await native.waitForInputs(1);
      await native.opens[0]!.functionTools![0]!.call(action);
      native.complete('');
      const actions = outputPromise ? await outputPromise : [];
      if (stream) {
          let cursor = 0;
          while (true) {
            const page = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId,
              cursor, waitForEvents: true });
            cursor = page.nextCursor;
            expect(page.events.filter(event => event.t === 'error')).toEqual([]);
            for (const event of page.events) {
              if (event.t === 'voice_output' && event.output.kind === 'side_effect') actions.push(event.output.action);
            }
            if (page.done) break;
          }
      }
      expect(actions).toEqual([expect.objectContaining(action)]);
      const admitted = actions[0];
      if (!admitted) throw new Error('Expected admitted Voice Action');
      expect(JSON.parse(await handlers.action_execute!({ actionId: 'settings.set', input: admitted.args },
        { effectId: 'manager-voice-setting', serverId, turnOrigin: 'person' })))
        .toMatchObject({ ok: true, result: { value: 1100 } });
      expect(readBacks).toBe(1);
      expect(home.artifacts(serverId).list()).toEqual([]);
      expect(version).toBe(2);
    } finally { await manager.dispose(); }
  });
});
