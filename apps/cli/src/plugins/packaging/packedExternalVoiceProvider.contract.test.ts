import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { assertAgentSessionRealtimeRuntime, type AgentSessionRealtimeLifecycleEvent, type AgentSessionRealtimeRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import type { RealtimeVoiceProviderRuntime, VoiceRealtimeJsonValue, VoiceSdkHandleConnectionDriver } from '@happier-dev/plugin-sdk/voice/client';
import { loadPluginModule } from '../runtime/loadPluginModule';
import { inspectPluginDevelopmentSource } from '../authoring/sourceObserver';

const fixtureRoot = fileURLToPath(new URL(
  '../testkit/fixtures/packed-external-voice-provider',
  import.meta.url,
));
const publicAuthoringRoot = fileURLToPath(new URL(
  '../../../../../packages/plugin-sdk/examples/public-authoring',
  import.meta.url,
));

type SourceClientModule = Readonly<{
  activate(api: PluginClientApi): void;
}>;

type SourceDaemonModule = Readonly<Record<string, unknown>> & Readonly<{
  activate(api: Readonly<{
    agents: Pick<PluginApi['agents'], 'register'>;
    voiceProviders: Pick<PluginApi['voiceProviders'], 'register'>;
  }>): void;
}>;

const PACKED_CURRENT_UI_READ_RESPONSE_ID = 'packed-current-ui-read-response-1';
const PACKED_CURRENT_UI_INVOKE_RESPONSE_ID = 'packed-current-ui-invoke-response-1';
const PACKED_CURRENT_UI_COMMAND_ID = 'current-ui-command:packed-context';
const PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID = 'packed-current-ui-read-response-2';
const PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID = 'packed-current-ui-invoke-response-2';
const PACKED_SECOND_CURRENT_UI_COMMAND_ID = 'current-ui-command:packed-context-2';

function packedCurrentUiReadCallId(responseId: string): string {
  return `${responseId}:read`;
}

function packedCurrentUiInvokeCallId(responseId: string): string {
  return `${responseId}:invoke`;
}

async function expectPackedCurrentUiToolContract(
  runtime: RealtimeVoiceProviderRuntime,
): Promise<void> {
  let directReadCalls = 0;
  let directEffectCalls = 0;
  const driverRef: { current: VoiceSdkHandleConnectionDriver | null } = { current: null };
  const emittedControls: unknown[] = [];
  const signal = new AbortController().signal;
  const fixtureEventsBeforeConnection = (
    globalThis as typeof globalThis & { __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: readonly unknown[] }
  ).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?.length ?? 0;
  // Provider-managed capture does not exist until createConnection. The public
  // runtime must retain this exact desired mute and apply it before publishing
  // the connection instead of rejecting or acknowledging an unapplied value.
  // Only the provider-managed arm of the public runtime union owns that mute.
  if (runtime.microphoneMode !== 'provider_managed') {
    throw new Error(`packed_current_ui_microphone_mode:${runtime.microphoneMode}`);
  }
  await runtime.setInputMuted(true);
  const connection = await runtime.createConnection({
    session: {
      config: {
        selectedVoiceId: 'packed-voice-primary',
        profile: 'balanced',
        clientAuth: {
          kind: 'bearer_token',
          value: 'packed-client-auth',
          expiresAtMs: 1,
          placement: 'authorization_header',
        },
      },
      safeMetadata: {},
    },
    attemptId: 1,
    mic: {
      async ensureActive() {},
      setMuted() {},
      isMuted: () => false,
      async teardown() {},
      getStream: () => null,
    },
    interruption: { duckGain: 0.25, retainedOutputMaxMs: 500 },
    levels: { onOutputLevel() {} },
    media: {
      createSdkHandleConnection(input) {
        driverRef.current = input.driver;
        return {
          kind: 'sdk_handle',
          async connect() {},
          async sendControl(event) {
            const driver = driverRef.current;
            if (!driver) throw new Error('packed_current_ui_driver_missing');
            await driver.sendControl(event);
          },
          controlEvents: async function* () {},
          transportEvents: async function* () {},
          async close() {},
          state: () => 'open' as const,
          currentProviderSessionId: () => null,
          playbackCursorMs: () => null,
          beginOutputInterruptionCandidate: () => 'unsupported' as const,
          resolveOutputInterruptionCandidate() {},
        };
      },
      createWebRtcConnection() {
        throw new Error('packed_current_ui_unexpected_webrtc_connection');
      },
      createPcmConnection() {
        throw new Error('packed_current_ui_unexpected_pcm_connection');
      },
    },
    tools: [{
      name: 'readCurrentUiContext',
      description: 'Direct fixture reads must not be used for the effectful flow.',
      parameters: {},
      async execute() {
        directReadCalls += 1;
        return {
          entity: { label: 'Packed Voice current context' },
          commands: [{ id: PACKED_CURRENT_UI_COMMAND_ID }],
        };
      },
    }, {
      name: 'invokeCurrentUiCommand',
      description: 'Effectful calls require canonical response and call identities.',
      parameters: {},
      async execute() {
        directEffectCalls += 1;
        throw new Error('direct_effect_requires_stable_response_and_call_ids');
      },
    }],
    ui: {} as never,
    signal,
    execution: { kind: 'direct_media' },
    credentials: { phase: 'connection', mediated: null, raw: null },
  });

  expect(connection.kind).toBe('sdk_handle');
  const startupEvents = (
    globalThis as typeof globalThis & { __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: readonly unknown[] }
  ).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?.slice(fixtureEventsBeforeConnection) ?? [];
  expect(startupEvents).toContainEqual({ kind: 'mediated_input_muted', muted: true });
  const activeDriver = driverRef.current;
  if (!activeDriver) throw new Error('packed_current_ui_driver_missing');
  await activeDriver.open({
    signal,
    onControl(event) {
      emittedControls.push(event);
    },
    onTransport() {},
    onRemoteClose() {},
  });

  const readControl = {
    kind: 'fixture_tool_call',
    responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
    callId: packedCurrentUiReadCallId(PACKED_CURRENT_UI_READ_RESPONSE_ID),
    toolName: 'readCurrentUiContext',
    arguments: {},
  } satisfies VoiceRealtimeJsonValue;
  const expectedReadCalls = [{
    type: 'tool_calls' as const,
    responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
    calls: [{
      v: 1 as const,
      responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
      callId: packedCurrentUiReadCallId(PACKED_CURRENT_UI_READ_RESPONSE_ID),
      toolName: 'readCurrentUiContext',
      order: 0,
      arguments: {},
    }],
  }];
  expect(emittedControls).toContainEqual(readControl);
  expect(runtime.protocol.decodeControl(readControl)).toEqual(expectedReadCalls);
  // The provider adapter deliberately leaves replay/conflict custody to the host barrier.
  expect(runtime.protocol.decodeControl(readControl)).toEqual(expectedReadCalls);
  const conflictingControl = {
    kind: 'fixture_tool_call',
    responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
    callId: packedCurrentUiReadCallId(PACKED_CURRENT_UI_READ_RESPONSE_ID),
    toolName: 'invokeCurrentUiCommand',
    arguments: { commandId: 'current-ui-command:conflict' },
  } satisfies VoiceRealtimeJsonValue;
  expect(runtime.protocol.decodeControl(conflictingControl)).toEqual([{
    type: 'tool_calls',
    responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
    calls: [{
      v: 1,
      responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
      callId: packedCurrentUiReadCallId(PACKED_CURRENT_UI_READ_RESPONSE_ID),
      toolName: 'invokeCurrentUiCommand',
      order: 0,
      arguments: { commandId: 'current-ui-command:conflict' },
    }],
  }]);

  const [readResults] = runtime.encodeToolResults([{
    v: 1,
    responseId: PACKED_CURRENT_UI_READ_RESPONSE_ID,
    callId: packedCurrentUiReadCallId(PACKED_CURRENT_UI_READ_RESPONSE_ID),
    toolName: 'readCurrentUiContext',
    order: 0,
    status: 'success',
    output: {
      entity: { label: 'Packed Voice current context' },
      commands: [{ id: PACKED_CURRENT_UI_COMMAND_ID }],
    },
  }]);
  if (!readResults) throw new Error('packed_current_ui_read_results_missing');
  await activeDriver.sendControl(readResults);
  await activeDriver.sendControl(runtime.encodeToolContinuation(PACKED_CURRENT_UI_READ_RESPONSE_ID));

  const invokeControl = {
    kind: 'fixture_tool_call',
    responseId: PACKED_CURRENT_UI_INVOKE_RESPONSE_ID,
    callId: packedCurrentUiInvokeCallId(PACKED_CURRENT_UI_INVOKE_RESPONSE_ID),
    toolName: 'invokeCurrentUiCommand',
    arguments: { commandId: PACKED_CURRENT_UI_COMMAND_ID },
  } satisfies VoiceRealtimeJsonValue;
  expect(emittedControls).toContainEqual(invokeControl);
  expect(runtime.protocol.decodeControl(invokeControl)).toEqual([{
    type: 'tool_calls',
    responseId: PACKED_CURRENT_UI_INVOKE_RESPONSE_ID,
    calls: [{
      v: 1,
      responseId: PACKED_CURRENT_UI_INVOKE_RESPONSE_ID,
      callId: packedCurrentUiInvokeCallId(PACKED_CURRENT_UI_INVOKE_RESPONSE_ID),
      toolName: 'invokeCurrentUiCommand',
      order: 0,
      arguments: { commandId: PACKED_CURRENT_UI_COMMAND_ID },
    }],
  }]);
  const [invokeResults] = runtime.encodeToolResults([{
    v: 1,
    responseId: PACKED_CURRENT_UI_INVOKE_RESPONSE_ID,
    callId: packedCurrentUiInvokeCallId(PACKED_CURRENT_UI_INVOKE_RESPONSE_ID),
    toolName: 'invokeCurrentUiCommand',
    order: 0,
    status: 'success',
    output: { opened: true },
  }]);
  if (!invokeResults) throw new Error('packed_current_ui_invoke_results_missing');
  await activeDriver.sendControl(invokeResults);

  const [secondTextTurn] = runtime.encodeTextTurn('read refreshed packed current context');
  if (!secondTextTurn) throw new Error('packed_current_ui_second_text_turn_missing');
  await activeDriver.sendControl(secondTextTurn);
  const secondReadControl = {
    kind: 'fixture_tool_call',
    responseId: PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID,
    callId: packedCurrentUiReadCallId(PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID),
    toolName: 'readCurrentUiContext',
    arguments: {},
  } satisfies VoiceRealtimeJsonValue;
  expect(secondReadControl.callId).not.toBe(readControl.callId);
  expect(emittedControls).toContainEqual(secondReadControl);
  expect(runtime.protocol.decodeControl(secondReadControl)).toEqual([{
    type: 'tool_calls',
    responseId: PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID,
    calls: [{
      v: 1,
      responseId: PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID,
      callId: packedCurrentUiReadCallId(PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID),
      toolName: 'readCurrentUiContext',
      order: 0,
      arguments: {},
    }],
  }]);
  const [secondReadResults] = runtime.encodeToolResults([{
    v: 1,
    responseId: PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID,
    callId: packedCurrentUiReadCallId(PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID),
    toolName: 'readCurrentUiContext',
    order: 0,
    status: 'success',
    output: {
      entity: { label: 'Packed Voice refreshed current context' },
      commands: [{ id: PACKED_SECOND_CURRENT_UI_COMMAND_ID }],
    },
  }]);
  if (!secondReadResults) throw new Error('packed_current_ui_second_read_results_missing');
  await activeDriver.sendControl(secondReadResults);
  await activeDriver.sendControl(runtime.encodeToolContinuation(PACKED_SECOND_CURRENT_UI_READ_RESPONSE_ID));
  const secondInvokeControl = {
    kind: 'fixture_tool_call',
    responseId: PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID,
    callId: packedCurrentUiInvokeCallId(PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID),
    toolName: 'invokeCurrentUiCommand',
    arguments: { commandId: PACKED_SECOND_CURRENT_UI_COMMAND_ID },
  } satisfies VoiceRealtimeJsonValue;
  expect(secondInvokeControl.callId).not.toBe(invokeControl.callId);
  expect(emittedControls).toContainEqual(secondInvokeControl);
  expect(runtime.protocol.decodeControl(secondInvokeControl)).toEqual([{
    type: 'tool_calls',
    responseId: PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID,
    calls: [{
      v: 1,
      responseId: PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID,
      callId: packedCurrentUiInvokeCallId(PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID),
      toolName: 'invokeCurrentUiCommand',
      order: 0,
      arguments: { commandId: PACKED_SECOND_CURRENT_UI_COMMAND_ID },
    }],
  }]);
  const [secondInvokeResults] = runtime.encodeToolResults([{
    v: 1,
    responseId: PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID,
    callId: packedCurrentUiInvokeCallId(PACKED_SECOND_CURRENT_UI_INVOKE_RESPONSE_ID),
    toolName: 'invokeCurrentUiCommand',
    order: 0,
    status: 'success',
    output: { opened: 'second' },
  }]);
  if (!secondInvokeResults) throw new Error('packed_current_ui_second_invoke_results_missing');
  await activeDriver.sendControl(secondInvokeResults);
  const fixtureEvents = (
    globalThis as typeof globalThis & { __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: readonly unknown[] }
  ).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__;
  expect(fixtureEvents).toContainEqual({
    kind: 'current_ui_context_invoked',
    result: { opened: true },
  });
  expect(fixtureEvents).toContainEqual({
    kind: 'current_ui_context_invoked',
    result: { opened: 'second' },
  });
  expect(directReadCalls).toBe(0);
  expect(directEffectCalls).toBe(0);
  await activeDriver.close({ code: 'user_stop' });
}

async function expectPackedRawConnectionMaterializationContract(
  runtime: RealtimeVoiceProviderRuntime,
  platform: 'web' | 'ios' | 'android',
): Promise<void> {
  const driverRef: { current: VoiceSdkHandleConnectionDriver | null } = { current: null };
  const materializationCalls: Readonly<{
    request: unknown;
    signal: AbortSignal | undefined;
  }>[] = [];
  const signal = new AbortController().signal;
  const connection = await runtime.createConnection({
    session: { config: {}, safeMetadata: {} },
    attemptId: 1,
    mic: {
      async ensureActive() {},
      setMuted() {},
      isMuted: () => false,
      async teardown() {},
      getStream: () => null,
    },
    interruption: { duckGain: 0.25, retainedOutputMaxMs: 500 },
    levels: { onOutputLevel() {} },
    media: {
      createSdkHandleConnection(input) {
        driverRef.current = input.driver;
        return {
          kind: 'sdk_handle',
          async connect() {},
          async sendControl(event) {
            const driver = driverRef.current;
            if (!driver) throw new Error(`packed_raw_driver_missing:${platform}`);
            await driver.sendControl(event);
          },
          controlEvents: async function* () {},
          transportEvents: async function* () {},
          async close() {},
          state: () => 'open' as const,
          currentProviderSessionId: () => null,
          playbackCursorMs: () => null,
          beginOutputInterruptionCandidate: () => 'unsupported' as const,
          resolveOutputInterruptionCandidate() {},
        };
      },
      createWebRtcConnection() {
        throw new Error(`packed_raw_unexpected_webrtc_connection:${platform}`);
      },
      createPcmConnection() {
        throw new Error(`packed_raw_unexpected_pcm_connection:${platform}`);
      },
    },
    tools: [],
    ui: {} as never,
    signal,
    execution: { kind: 'direct_media' },
    credentials: {
      phase: 'connection',
      mediated: null,
      raw: {
        async materialize(request, options) {
          materializationCalls.push({ request, signal: options?.signal });
          return {
            kind: 'httpHeaders',
            headers: { authorization: `Bearer packed-${platform}-raw-credential` },
          };
        },
      },
    },
  });

  expect(connection.kind).toBe('sdk_handle');
  expect(materializationCalls).toEqual([{
    request: {
      kind: 'httpHeaders',
      origin: 'https://voice.example.test',
      headerNames: ['authorization'],
    },
    signal,
  }]);
  const driver = driverRef.current;
  if (!driver) throw new Error(`packed_raw_driver_missing:${platform}`);
  await driver.open({
    signal,
    onControl() {},
    onTransport() {},
    onRemoteClose() {},
  });
  const fixtureEvents = (
    globalThis as typeof globalThis & { __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: readonly unknown[] }
  ).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__;
  expect(fixtureEvents).toContainEqual({ kind: 'raw_connection_authorized' });
  expect(fixtureEvents).toContainEqual({ kind: 'raw_connection_opened' });
  await driver.close({ code: 'user_stop' });
}

async function expectPackedVoiceAgentRealtimeSession(
  session: AgentSessionRealtimeRuntime,
): Promise<void> {
  await expect(session.realtimeConversation.inspect()).resolves.toEqual({
    status: 'available',
    transport: 'webrtc',
  });
  const aborted = new AbortController();
  aborted.abort(new Error('packed_voice_generation_retired'));
  await expect(session.realtimeConversation.start({
    transport: { kind: 'webrtc', offerSdp: 'packed-offer' },
  }, { signal: aborted.signal })).resolves.toEqual({ status: 'aborted' });

  const first = await session.realtimeConversation.start({
    transport: { kind: 'webrtc', offerSdp: 'packed-offer' },
  });
  expect(first).toMatchObject({
    status: 'started',
    transport: { kind: 'webrtc', answerSdp: 'packed-answer-sdp' },
    handle: { stop: expect.any(Function), watch: expect.any(Function), dispose: expect.any(Function) },
  });
  if (first.status !== 'started') throw new Error('packed_voice_realtime_start_required');

  await expect(session.realtimeConversation.start({
    transport: { kind: 'webrtc', offerSdp: 'packed-offer-while-live' },
  })).resolves.toEqual({ status: 'busy' });

  const existingWatcherEvents: AgentSessionRealtimeLifecycleEvent[] = [];
  const existingWatcher = first.handle.watch((event) => {
    existingWatcherEvents.push(event);
  });
  await expect(first.handle.stop()).resolves.toEqual({ status: 'stopped' });
  expect(existingWatcherEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);

  const lateWatcherEvents: AgentSessionRealtimeLifecycleEvent[] = [];
  const lateWatcher = first.handle.watch((event) => {
    lateWatcherEvents.push(event);
  });
  expect(lateWatcherEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
  await expect(first.handle.stop()).resolves.toEqual({ status: 'already_stopped' });
  expect(existingWatcherEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
  expect(lateWatcherEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
  existingWatcher.dispose();
  lateWatcher.dispose();

  const second = await session.realtimeConversation.start({
    transport: { kind: 'webrtc', offerSdp: 'packed-offer-after-terminal' },
  });
  expect(second).toMatchObject({ status: 'started' });
  if (second.status !== 'started') throw new Error('packed_voice_realtime_restart_required');
  const disposedWatcherEvents: AgentSessionRealtimeLifecycleEvent[] = [];
  second.handle.watch((event) => {
    disposedWatcherEvents.push(event);
  });
  await second.handle.dispose();
  expect(disposedWatcherEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);

  const third = await session.realtimeConversation.start({
    transport: { kind: 'webrtc', offerSdp: 'packed-offer-after-dispose' },
  });
  expect(third).toMatchObject({ status: 'started' });
  if (third.status !== 'started') throw new Error('packed_voice_realtime_dispose_restart_required');
  await third.handle.dispose();
}

describe('packed external Voice provider author contract', () => {
  it('declares raw SavedSecret and Connected Account grants for every raw conversation platform', async () => {
    const manifest = JSON.parse(await readFile(
      join(fixtureRoot, '.happier-plugin', 'plugin.json'),
      'utf8',
    )) as Readonly<{
      contributes: Readonly<{
        voiceProviders: readonly Readonly<{
          id: string;
          platforms: readonly string[];
          credentials?: Readonly<{
            sources: readonly Readonly<{
              rawGrants?: readonly Readonly<{
                realm: string;
                phase: string;
                request: unknown;
              }>[];
            }>[];
          }>;
        }>[];
      }>;
    }>;
    const clientPlatforms = ['web', 'ios', 'android'] as const;
    const rawConversation = manifest.contributes.voiceProviders.find(
      ({ id }) => id === 'conversation-raw',
    );

    expect(rawConversation?.platforms).toEqual(clientPlatforms);
    expect(rawConversation?.credentials?.sources).toHaveLength(2);
    for (const source of rawConversation?.credentials?.sources ?? []) {
      expect(source.rawGrants).toEqual(clientPlatforms.map((realm) => ({
        realm,
        phase: 'connection',
        request: {
          kind: 'httpHeaders',
          origin: 'https://voice.example.test',
          headerNames: ['authorization'],
        },
      })));
    }
  });

  it('materializes and opens the raw conversation runtime through public client activation on every declared platform', async () => {
    // Same-realm packed CJS activation belongs to the UI loader/evaluator suite.
    // This CLI contract keeps client behavior source-owned and exercises the
    // independently executable packed daemon below.
    const clientModule = await import(pathToFileURL(
      join(fixtureRoot, 'src', 'voiceRuntime.tsx'),
    ).href) as SourceClientModule;

    for (const platform of ['web', 'ios', 'android'] as const) {
      const registeredProviders = new Map<string, RealtimeVoiceProviderRuntime>();
      const api: PluginClientApi = {
        dragSources: { register() { throw new Error('Unexpected drag source'); } },
        dropTargets: { register() { throw new Error('Unexpected drop target'); } },
        actions: { register() {} },
        voiceProviders: {
          register(localId, runtime) {
            if (runtime.kind === 'conversation') registeredProviders.set(localId, runtime);
          },
        },
      };

      clientModule.activate(api);
      const rawRuntime = registeredProviders.get('conversation-raw');
      if (!rawRuntime) throw new Error(`packed_raw_runtime_missing:${platform}`);
      await expectPackedRawConnectionMaterializationContract(rawRuntime, platform);
    }
  });

  it('runs one public source activation on every declared client platform and selects only published fixture output', async () => {
    const [manifestSource, packageSource, buildConfigModule, clientModule] = await Promise.all([
      readFile(join(fixtureRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
      readFile(join(fixtureRoot, 'package.json'), 'utf8'),
      import(pathToFileURL(join(fixtureRoot, 'pluginUiBuild.ts')).href),
      import(pathToFileURL(join(fixtureRoot, 'src', 'voiceRuntime.tsx')).href) as Promise<SourceClientModule>,
    ]);
    const manifest = JSON.parse(manifestSource) as Readonly<{
      entrypoints: Readonly<{
        daemon: string;
        development: string;
      }>;
      contributes: Readonly<{
        actions: readonly Readonly<{
          id: string;
          execution: Readonly<{ platforms: readonly string[] }>;
        }>[];
        voiceProviders: readonly Readonly<{
          id: string;
          kind: string;
          platforms: readonly string[];
        }>[];
      }>;
    }>;
    const packageJson = JSON.parse(packageSource) as Readonly<{
      files: readonly string[];
      scripts: Readonly<Record<string, string>>;
    }>;
    const clientPlatforms = ['web', 'ios', 'android'] as const;
    const conversationLocalIds = ['conversation-mediated', 'conversation-raw'];

    await expect(inspectPluginDevelopmentSource({ projectRoot: fixtureRoot })).resolves.toMatchObject({
      ok: true,
      sourceKind: 'packageRoot',
      authoringKind: 'manifest',
      sourceRootPath: fixtureRoot,
      developmentEntryPath: join(fixtureRoot, 'src', 'voiceDaemon.ts'),
    });
    expect(manifest.entrypoints).toEqual({
      daemon: './dist/daemon.js',
      development: './src/voiceDaemon.ts',
    });
    const daemonModule = await loadPluginModule<SourceDaemonModule>({
      source: {
        kind: 'file_backed',
        entryPath: join(fixtureRoot, 'dist', 'daemon.js'),
        devEntryPath: join(fixtureRoot, 'src', 'voiceDaemon.ts'),
        useDevelopmentEntry: true,
        trustPolicy: 'prompt',
        committedAuthorization: {
          pluginId: 'acme.packed-voice',
          immutableGenerationId: 'packed-external-voice-source-contract',
        },
      },
    });

    expect(manifest.contributes.actions).toEqual([expect.objectContaining({
      id: 'open-packed-current-context',
      execution: expect.objectContaining({ platforms: clientPlatforms }),
    })]);
    expect(manifest.contributes.voiceProviders
      .filter(({ kind }) => kind === 'conversation')
      .map(({ id, platforms }) => ({ id, platforms })))
      .toEqual(conversationLocalIds.map((id) => ({ id, platforms: clientPlatforms })));
    expect(buildConfigModule.pluginUiBuildConfig.targets).toEqual([expect.objectContaining({
      rendererId: 'voice-runtime-web',
      entry: 'src/voiceRuntime.tsx',
      kind: 'reactNative',
      platforms: clientPlatforms,
      module: {
        containerName: 'happier_plugin_acme_packed_voice_voice_runtime_web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    })]);
    expect(packageJson.files).toEqual([
      '.happier-plugin',
      'dist/agentRuntime.js',
      'dist/daemon.js',
      'dist/happier-plugin-ui',
    ]);
    expect(packageJson.scripts['build:ui']).toBe('happier-plugin-build-ui --project-root .');

    for (const platform of clientPlatforms) {
      const registeredActions = new Set<string>();
      const registeredProviders = new Map<string, RealtimeVoiceProviderRuntime>();
      const api: PluginClientApi = {
        dragSources: { register() { throw new Error('Unexpected drag source'); } },
        dropTargets: { register() { throw new Error('Unexpected drop target'); } },
        actions: {
          register(localId) {
            registeredActions.add(localId);
          },
        },
        voiceProviders: {
          register(localId, runtime) {
            if (runtime.kind === 'conversation') {
              registeredProviders.set(localId, runtime);
            }
          },
        },
      };

      clientModule.activate(api);

      expect(registeredActions).toEqual(new Set(['open-packed-current-context']));
      expect([...registeredProviders.keys()]).toEqual(conversationLocalIds);
      expect(manifest.contributes.actions[0]?.execution.platforms).toContain(platform);
      const mediatedRuntime = registeredProviders.get('conversation-mediated');
      if (!mediatedRuntime) throw new Error(`packed_current_ui_runtime_missing:${platform}`);
      await expectPackedCurrentUiToolContract(mediatedRuntime);
    }

    const daemonAgents = new Map<string, Parameters<PluginApi['agents']['register']>[1]>();
    const daemonRegistrations = new Map<string, unknown>();
    daemonModule.activate({
      agents: {
        register(localId, factory) {
          daemonAgents.set(localId, factory);
        },
      },
      voiceProviders: {
        register(localId, runtime) {
          daemonRegistrations.set(localId, runtime);
        },
      },
    });

    expect([...daemonAgents.keys()]).toEqual(['voice-agent']);
    expect([...daemonRegistrations.keys()]).toEqual(['speech-stt', 'speech-tts']);

    const daemonAgentRuntime = await daemonAgents.get('voice-agent')?.({
      plugin: { id: 'acme.packed-voice', version: '1.0.0' },
      agent: { id: 'voice-agent' },
      signal: new AbortController().signal,
    });
    if (!daemonAgentRuntime?.sessions) throw new Error('source_voice_agent_runtime_required');
    const sourceSession = assertAgentSessionRealtimeRuntime(await daemonAgentRuntime.sessions.open({
      kind: 'create',
      sessionId: 'packed-source-voice-agent-session',
      cwd: '/tmp',
    }, {} as never));
    try {
      await expectPackedVoiceAgentRealtimeSession(sourceSession);
    } finally {
      await Promise.resolve(sourceSession.dispose()).catch(() => undefined);
    }
  });

  it('uses final public SDK paths and declares exact raw SavedSecret and Connected Account grants', async () => {
    const manifest = JSON.parse(await readFile(
      join(fixtureRoot, '.happier-plugin', 'plugin.json'),
      'utf8',
    )) as Readonly<{
      id: string;
      contributes: Readonly<{
        agents?: readonly Readonly<{
          id: string;
          primary?: string;
          runtime?: Readonly<{ kind: string }>;
        }>[];
        voiceProviders: readonly Readonly<{
          id: string;
          execution?: Readonly<{
            kind: string;
            agent: string | Readonly<{ pluginId: string; localId: string }>;
            supportedRuntimeVersions: readonly string[];
          }>;
          credentials?: Readonly<{ sources: readonly unknown[] }>;
          settings?: Readonly<{
            actions?: readonly Readonly<{ id: string }>[];
          }>;
          catalogs?: readonly Readonly<{ kind: string; settingFieldId: string }>[];
        }>[];
      }>;
    }>;
    const rawConversation = manifest.contributes.voiceProviders.find(
      ({ id }) => id === 'conversation-raw',
    );
    const agentRealtimeConversation = manifest.contributes.voiceProviders.find(
      ({ id }) => id === 'conversation-mediated',
    );

    expect(ingestPluginManifestV2(manifest)).toMatchObject({ ok: true });
    expect(manifest.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'voice-agent',
        primary: 'sessions',
        runtime: { kind: 'custom' },
      }),
    ]);
    expect(agentRealtimeConversation?.execution).toEqual({
      kind: 'experimental_agent_session_realtime',
      agent: 'voice-agent',
      supportedRuntimeVersions: ['1.0.0'],
    });
    expect(manifest.contributes.voiceProviders.map(({ id }) => (
      `${manifest.id}/${id}`
    ))).toEqual([
      'acme.packed-voice/conversation-mediated',
      'acme.packed-voice/conversation-raw',
      'acme.packed-voice/speech-stt',
      'acme.packed-voice/speech-tts',
    ]);
    expect(manifest.contributes.voiceProviders.flatMap(({ id, settings }) => (
      (settings?.actions ?? []).map((action) => `${id}/${action.id}`)
    ))).toEqual(['conversation-mediated/provision-voice']);
    expect(manifest.contributes.voiceProviders.find(({ id }) => id === 'speech-stt')?.catalogs)
      .toEqual([{ kind: 'models', settingFieldId: 'model', allowCustom: true }]);
    expect(manifest.contributes.voiceProviders.find(({ id }) => id === 'speech-tts')?.catalogs)
      .toEqual([{ kind: 'voices', settingFieldId: 'voice', allowCustom: false }]);
    expect(JSON.stringify(manifest)).not.toMatch(
      /registerSpeech|speechProviderIds|catalogProviders|accountMediation|PluginVoice|providerId/u,
    );

    expect(rawConversation?.credentials?.sources).toEqual([
      expect.objectContaining({
        kind: 'savedSecret',
        rawGrants: expect.arrayContaining([
          expect.objectContaining({ realm: 'web', phase: 'connection' }),
          expect.objectContaining({ realm: 'ios', phase: 'connection' }),
          expect.objectContaining({ realm: 'android', phase: 'connection' }),
        ]),
      }),
      expect.objectContaining({
        kind: 'connectedAccount',
        service: { pluginId: 'acme.connected-accounts', localId: 'voice-oauth' },
        rawGrants: expect.arrayContaining([
          expect.objectContaining({ realm: 'web', phase: 'connection' }),
          expect.objectContaining({ realm: 'ios', phase: 'connection' }),
          expect.objectContaining({ realm: 'android', phase: 'connection' }),
        ]),
      }),
    ]);

    const publicAuthoringSources = (await Promise.all([
      readFile(join(publicAuthoringRoot, 'voiceProvider.ts'), 'utf8'),
      readFile(join(publicAuthoringRoot, 'voiceSpeechProvider.ts'), 'utf8'),
    ])).join('\n');
    expect(publicAuthoringSources).toMatch(/from '@happier-dev\/plugin-sdk\/voice'/u);
    expect(publicAuthoringSources).toMatch(/from '@happier-dev\/plugin-sdk\/voice\/client'/u);
    expect(publicAuthoringSources).toMatch(/from '@happier-dev\/plugin-sdk\/voice\/speech'/u);
    expect(publicAuthoringSources).toContain('credentials.raw.materialize');
    expect(publicAuthoringSources).not.toContain('voice_raw_credentials_unavailable');
    expect(publicAuthoringSources).not.toMatch(
      /@happier-dev\/plugin-sdk\/(?:runtime|ui\/client)|registerSpeech|PluginVoice|accountMediation|speechProviderIds|catalogProviders|providerId/u,
    );

    const { publicAuthoringDefinition } = await import(pathToFileURL(
      join(publicAuthoringRoot, 'definition.ts'),
    ).href);
    const publicRawConversation = publicAuthoringDefinition.voiceProviders?.['raw-browser']?.declaration;
    expect(publicRawConversation?.credentials?.sources).toEqual([
      expect.objectContaining({ kind: 'savedSecret' }),
      expect.objectContaining({
        kind: 'connectedAccount',
        service: { pluginId: 'acme.connected-accounts', localId: 'voice-oauth' },
      }),
    ]);
  });
});
