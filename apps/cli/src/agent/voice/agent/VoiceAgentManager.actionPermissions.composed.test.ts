import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createNativeVoiceActionHarness } from '../../../../../ui/sources/dev/testkit/harness/nativeVoiceActionHarness';
import { UiActionDispatchResultV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createRootLayoutFeaturesResponse } from '../../../../../ui/sources/dev/testkit/fixtures/featureFixtures';
import { installVitestRnShim } from '../../../../../ui/sources/dev/vitestRnShim';
import { installLocalStorageMock } from '../../../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import { createNativeSessionBoundary, createVoiceSessionRuntimeThroughNativeFactory } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import { VoiceAgentManager } from './VoiceAgentManager';

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

describe('native Voice Actions through the canonical client owner', () => {
  it('returns real Home reads during the native turn and allows repair after invalid input', async () => {
    const serverId = await home.addHome({ name: 'Native read Home', serverUrl: 'https://native-read.test',
      accountId: 'alice', currentAccount: true });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
    const voice = await createNativeVoiceActionHarness(async (actionId, input, callId) =>
      UiActionDispatchResultV1Schema.parse({ v: 1, execution: JSON.parse(await handlers.action_execute!(
        { actionId, input }, { effectId: callId, serverId, turnOrigin: 'person' })) }).execution);
    try {
      const started = await voice.manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      for (const count of [1, 2]) {
        const turn = voice.manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'List my Homes' });
        void turn.catch(() => {});
        await voice.native.waitForInputs(count);
        const tool = voice.native.opens[0]?.functionTools?.find(candidate => candidate.name === 'happier_voice_action');
        if (!tool) throw new Error('Missing native Voice Action function');
        expect(await tool.call({}, { callId: `invalid-${count}` })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        const result = await tool.call({ t: 'listServers', args: {} }, { callId: `native-home-read-${count}` });
        expect(result).toMatchObject({ ok: true });
        expect(JSON.stringify(result)).toContain(serverId);
        voice.native.complete('Your Home is connected.');
        await expect(turn).resolves.toMatchObject({ assistantText: 'Your Home is connected.' });
      }
    } finally { await voice.dispose(); }
  });

  it('uses the shared Action surface without requiring native functions for an OpenCode Voice turn', async () => {
    const native = createNativeSessionBoundary();
    const manager = new VoiceAgentManager({ createRuntime: options => createVoiceSessionRuntimeThroughNativeFactory({
      runtime: { sessions: { open: request => native.open(request) } }, modelId: 'mcp-voice',
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true }, functionTools: options.functionTools,
    }) });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: 'default', idleTtlSeconds: 60, initialContext: '' },
      { actionTransport: 'mcp' });
      expect(native.opens[0]?.functionTools).toBeUndefined();
      const turn = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Read my Inbox' });
      await native.waitForInputs(1);
      expect(native.inputs[0]?.input.text).toContain('action_spec_search');
      expect(native.inputs[0]?.input.text).toContain('action_execute');
      native.complete('The Inbox has two requests.');
      await expect(turn).resolves.toMatchObject({ assistantText: 'The Inbox has two requests.' });
    } finally { await manager.dispose(); }
  });

  it.each(['read-only', 'narrowed', 'default'] as const)('settles %s native settings Action after one spoken confirmation', async mode => {
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
    let readBacks = 0;
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId,
      playHostText: async ({ text }) => {
        expect(text).toBeTruthy(); expect(version).toBe(1); readBacks += 1;
        return { status: 'completed' as const };
      },
    });
    const voice = await createNativeVoiceActionHarness(async (actionId, input, callId) =>
      UiActionDispatchResultV1Schema.parse({ v: 1, execution: JSON.parse(await handlers.action_execute!(
        { actionId, input }, { effectId: callId, serverId, turnOrigin: 'person' })) }).execution);
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'spoken-manager-call',
      status: 'connected', mode: 'listening', canStop: true });
    try {
      const started = await voice.manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: mode === 'read-only' ? 'read-only' : 'default',
        idleTtlSeconds: 60, initialContext: '' });
      const stream = mode === 'narrowed' ? await voice.manager.startTurnStream({ voiceAgentId: started.voiceAgentId,
        userText: 'Use the settings Action', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
      }) : null;
      const turn = stream ? null : voice.manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Use the settings Action' });
      void turn?.catch(() => {});
      await voice.native.waitForInputs(1);
      expect(await voice.native.opens[0]!.functionTools![0]!.call({ t: 'settings_set',
        args: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } }, { callId: 'native-voice-setting' }))
        .toMatchObject({ ok: true, result: { value: 1100 } });
      expect(readBacks).toBe(1); expect(version).toBe(2); expect(home.artifacts(serverId).list()).toEqual([]);
      voice.native.complete('The setting was updated.');
      if (turn) await expect(turn).resolves.toMatchObject({ assistantText: 'The setting was updated.' });
      if (stream) {
        let cursor = 0;
        while (true) {
          const page = await voice.manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId,
            cursor, waitForEvents: true });
          cursor = page.nextCursor;
          expect(page.events.filter(event => event.t === 'error' || event.t === 'voice_output' && event.output.kind === 'side_effect')).toEqual([]);
          if (page.done) break;
        }
      }
    } finally { await voice.dispose(); }
  });
});
