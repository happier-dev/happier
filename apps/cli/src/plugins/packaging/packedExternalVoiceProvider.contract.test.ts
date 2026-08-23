import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as tar from 'tar';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import {
  assertAgentSessionRealtimeRuntime,
  type AgentSessionRealtimeLifecycleEvent,
  type AgentSessionRealtimeRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { resolveExecutablePluginRuntimeRegistry } from '../runtime/resolveExecutablePluginRuntimeRegistry';
import { loadRetainedAgentRuntimeLeaf } from '../runtime/runner/loadRetainedAgentRuntimeLeaf';
import { resolvePluginStorePaths } from '../store/paths';
import { seedCurrentLocalPathPluginFixture } from '../store/registry/currentState.testkit';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { packLocalPlugin } from './pack';

const fixtureRoot = fileURLToPath(new URL(
  '../testkit/fixtures/packed-external-voice-provider',
  import.meta.url,
));
const publicAuthoringRoot = fileURLToPath(new URL(
  '../../../../../packages/plugin-sdk/examples/public-authoring',
  import.meta.url,
));

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
        rawGrants: [expect.objectContaining({ realm: 'web', phase: 'connection' })],
      }),
      expect.objectContaining({
        kind: 'connectedAccount',
        service: { pluginId: 'acme.connected-accounts', localId: 'voice-oauth' },
        rawGrants: [expect.objectContaining({ realm: 'web', phase: 'connection' })],
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
    const api = {
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
    const clientModule = await import(new URL(
      '../testkit/fixtures/packed-external-voice-provider/dist/happier-plugin-ui/react-native/voice-runtime-web/index.js',
      import.meta.url,
    ).href) as Readonly<{ activate(input: typeof api): void }>;
    const daemonModule = await import(new URL(
      '../testkit/fixtures/packed-external-voice-provider/dist/daemon.js',
      import.meta.url,
    ).href) as Readonly<{ activate(input: typeof api): void }>;

    clientModule.activate(api);
    daemonModule.activate(api);

    expect([...registeredAgents]).toEqual(['voice-agent']);
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
