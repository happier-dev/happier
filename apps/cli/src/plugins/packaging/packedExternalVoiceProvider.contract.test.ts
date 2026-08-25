import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as tar from 'tar';
import * as React from 'react';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import {
  assertAgentSessionRealtimeRuntime,
  type AgentSessionRealtimeLifecycleEvent,
  type AgentSessionRealtimeRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import type {
  RealtimeVoiceProviderRuntime,
  VoiceRealtimeJsonValue,
  VoiceSdkHandleConnectionDriver,
} from '@happier-dev/plugin-sdk/voice/client';

import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { loadPluginModule } from '../runtime/loadPluginModule';
import { resolveExecutablePluginRuntimeRegistry } from '../runtime/resolveExecutablePluginRuntimeRegistry';
import { loadRetainedAgentRuntimeLeaf } from '../runtime/runner/loadRetainedAgentRuntimeLeaf';
import { resolvePluginStorePaths } from '../store/paths';
import { seedCurrentLocalPathPluginFixture } from '../store/registry/currentState.testkit';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { inspectPluginDevelopmentSource } from '../authoring/sourceObserver';
import { packLocalPlugin } from './pack';

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
    const clientModule = await import(pathToFileURL(
      join(fixtureRoot, 'src', 'voiceRuntime.tsx'),
    ).href) as SourceClientModule;

    for (const platform of ['web', 'ios', 'android'] as const) {
      const registeredProviders = new Map<string, RealtimeVoiceProviderRuntime>();
      const api: PluginClientApi = {
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
    const sourceDistribution = {
      kind: 'localPath' as const,
      canonicalPath: fixtureRoot,
    };
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
          distribution: sourceDistribution,
          trust: {
            pluginId: 'acme.packed-voice',
            distribution: sourceDistribution,
            state: 'trusted',
            approvedAtMs: 1,
          },
          isCurrent: async () => true,
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

  it('activates exact contribution runtimes and carries cancellation into raw and speech work', async () => {
    const registered = new Map<string, Record<string, unknown>>();
    const registeredAgents = new Set<string>();
    const registeredActions = new Set<string>();
    const api = {
      actions: {
        register(localId: string, _handler: unknown) {
          if (registeredActions.has(localId)) {
            throw new Error(`duplicate fixture Action registration: ${localId}`);
          }
          registeredActions.add(localId);
        },
      },
      agents: {
        register(
          localId: string,
          _factory: unknown,
          _options: unknown,
        ) {
          if (registeredAgents.has(localId)) {
            throw new Error(`duplicate fixture Agent registration: ${localId}`);
          }
          registeredAgents.add(localId);
        },
      },
      voiceProviders: {
        register(localId: string, runtime: Record<string, unknown>) {
          if (registered.has(localId)) throw new Error(`duplicate fixture registration: ${localId}`);
          registered.set(localId, runtime);
        },
      },
    };
    const hostRuntime = globalThis as typeof globalThis & {
      __happierPluginHostRuntime__?: Readonly<{ react: typeof React }>;
    };
    const priorHostRuntime = hostRuntime.__happierPluginHostRuntime__;
    hostRuntime.__happierPluginHostRuntime__ = { react: React };
    let clientModule: Readonly<{ activate(input: typeof api): void }>;
    try {
      clientModule = await import(new URL(
        '../testkit/fixtures/packed-external-voice-provider/dist/happier-plugin-ui/react-native-web/voice-runtime-web/entry.mjs.bundle',
        import.meta.url,
      ).href) as Readonly<{ activate(input: typeof api): void }>;
    } finally {
      if (priorHostRuntime) {
        hostRuntime.__happierPluginHostRuntime__ = priorHostRuntime;
      } else {
        delete hostRuntime.__happierPluginHostRuntime__;
      }
    }
    const daemonModule = await import(new URL(
      '../testkit/fixtures/packed-external-voice-provider/dist/daemon.js',
      import.meta.url,
    ).href) as Readonly<{ activate(input: typeof api): void }>;

    clientModule.activate(api);
    daemonModule.activate(api);

    expect([...registeredAgents]).toEqual(['voice-agent']);
    expect([...registeredActions]).toEqual(['open-packed-current-context']);
    expect([...registered].map(([localId, runtime]) => ({ localId, kind: runtime.kind }))).toEqual([
      { localId: 'conversation-mediated', kind: 'conversation' },
      { localId: 'conversation-raw', kind: 'conversation' },
      { localId: 'speech-stt', kind: 'speech' },
      { localId: 'speech-tts', kind: 'speech' },
    ]);

    const rawRuntime = registered.get('conversation-raw') as Readonly<{
      createConnection(input: Readonly<{
        credentials: Readonly<{
          phase: 'connection';
          mediated: null;
          raw: Readonly<{
            materialize(
              request: unknown,
              options?: Readonly<{ signal?: AbortSignal }>,
            ): Promise<unknown>;
          }>;
        }>;
        signal: AbortSignal;
      }>): Promise<unknown>;
    }>;
    const rawController = new AbortController();
    const materializationCalls: Readonly<{ request: unknown; signal: AbortSignal | undefined }>[] = [];
    const rawConnection = rawRuntime.createConnection({
      credentials: {
        phase: 'connection',
        mediated: null,
        raw: {
          async materialize(request, options) {
            materializationCalls.push({ request, signal: options?.signal });
            await new Promise<never>((_resolve, reject) => {
              const signal = options?.signal;
              if (!signal) {
                reject(new Error('packed_voice_raw_materialization_missing_signal'));
                return;
              }
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
        },
      },
      signal: rawController.signal,
    });
    rawController.abort(new Error('packed_voice_generation_retired'));
    await expect(rawConnection).rejects.toThrow('packed_voice_generation_retired');
    expect(materializationCalls).toEqual([{
      request: {
        kind: 'httpHeaders',
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      },
      signal: rawController.signal,
    }]);

    const speechSignal = new AbortController();
    speechSignal.abort(new Error('packed_voice_generation_retired'));
    const speechContext = {
      credentials: { phase: 'speech', mediated: null, raw: null },
      signal: speechSignal.signal,
    } as const;
    const sttRuntime = registered.get('speech-stt') as Readonly<{
      transcribe(request: Readonly<{ requestId: string }>, context: typeof speechContext): Promise<unknown>;
    }>;
    const ttsRuntime = registered.get('speech-tts') as Readonly<{
      synthesize(request: Readonly<{ requestId: string }>, context: typeof speechContext): Promise<unknown>;
    }>;
    await expect(sttRuntime.transcribe({ requestId: 'retired-stt' }, speechContext))
      .rejects.toThrow('packed_voice_generation_retired');
    await expect(ttsRuntime.synthesize({ requestId: 'retired-tts' }, speechContext))
      .rejects.toThrow('packed_voice_generation_retired');

    const mediatedRuntime = registered.get('conversation-mediated') as Readonly<{
      dispose(): Promise<void>;
    }>;
    await mediatedRuntime.dispose();
    const fixtureEvents = (
      globalThis as typeof globalThis & { __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: readonly unknown[] }
    ).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__;
    expect(fixtureEvents).toContainEqual({ kind: 'runtime_disposed' });
  });

  it('packs, stages, and runs the dependency-closed public fixture through its attested Agent runner', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-packed-voice-public-contract-'));
    const archivePath = join(parent, 'packed-voice.tgz');
    const installRoot = join(parent, 'installed');
    const runtimeHome = join(parent, 'runtime-home');
    let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;
    let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    let session: AgentSessionRealtimeRuntime | null = null;
    try {
      const packed = await packLocalPlugin({ locator: fixtureRoot, outPath: archivePath });
      expect(
        packed,
        packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n'),
      ).toMatchObject({ ok: true, pluginId: 'acme.packed-voice' });
      if (!packed.ok) return;

      const archiveBytes = await readFile(archivePath);
      await mkdir(installRoot);
      staged = await stageDownloadedNpmArtifactCandidate({
        candidate: {
          source: {
            kind: 'npm',
            registryOrigin: 'https://packed-voice.invalid',
            packageName: 'happier-plugin-acme-packed-voice',
            version: '1.0.0',
            integrity: sriSha512(archiveBytes),
            tarballUrl: pathToFileURL(archivePath).href,
          },
          artifactPath: archivePath,
          byteLength: archiveBytes.byteLength,
          archiveDigestSha256: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
          registrySignature: { status: 'absent' },
          provenance: { status: 'absent' },
        },
        stagingParentPath: installRoot,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;

      expect(staged.candidate.generatedUiArtifacts.contributionIds)
        .toEqual(['voice-runtime-web']);
      const archiveEntries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          archiveEntries.push(entry.path);
        },
      });
      expect(archiveEntries).toContain('package/dist/agentRuntime.js');
      await expect(readFile(
        join(staged.candidate.rootPath, 'dist', 'agentRuntime.js'),
        'utf8',
      )).resolves.toMatch(/export function createPackedVoiceAgentRuntime/u);

      await seedCurrentLocalPathPluginFixture({
        happyHomeDir: runtimeHome,
        pluginRoot: staged.candidate.rootPath,
        pluginId: 'acme.packed-voice',
        manifestVersion: '1.0.0',
      });
      runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: runtimeHome,
        pluginIds: ['acme.packed-voice'],
      });
      expect(runtimeRegistry.targetActivationFacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'acme.packed-voice',
          status: 'active',
          diagnostics: [],
        }),
      ]));
      expect(runtimeRegistry.contributes.agentDefinitionsById.get('acme.packed-voice/voice-agent')).toMatchObject({
        pluginId: 'acme.packed-voice',
        identity: { pluginId: 'acme.packed-voice', localId: 'voice-agent' },
        definition: { id: 'acme.packed-voice/voice-agent' },
      });
      const binding = runtimeRegistry.agentRuntimesByAgentId
        .get('acme.packed-voice/voice-agent')
        ?.sessionRunnerFactoryBinding;
      if (!binding || 'kind' in binding) {
        throw new Error('Expected an attested packed Voice Agent factory binding');
      }
      expect(binding).toMatchObject({
        locator: {
          module: './agentRuntime.js',
          export: 'createPackedVoiceAgentRuntime',
          runtimeApiVersion: 1,
        },
        normalizedModulePath: 'dist/agentRuntime.js',
        loadMode: 'immutable-js',
      });

      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: resolvePluginStorePaths({ happyHomeDir: runtimeHome }),
        binding,
      });
      const runtime = await leaf.factory({
        plugin: { id: 'acme.packed-voice', version: '1.0.0' },
        agent: { id: 'voice-agent' },
        signal: new AbortController().signal,
      });
      if (!runtime.sessions) throw new Error('Expected the packed Voice Agent session factory');
      session = assertAgentSessionRealtimeRuntime(await runtime.sessions.open({
        kind: 'create',
        sessionId: 'packed-voice-agent-session',
        cwd: '/tmp',
      }, {} as never));
      await expectPackedVoiceAgentRealtimeSession(session);
    } finally {
      if (session) await Promise.resolve(session.dispose()).catch(() => undefined);
      await runtimeRegistry?.dispose();
      if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });
});
