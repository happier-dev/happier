import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as tar from 'tar';
import { assertAgentSessionRealtimeRuntime, type AgentSessionRealtimeLifecycleEvent, type AgentSessionRealtimeRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { cleanupStagedNpmArtifactCandidate, stageDownloadedNpmArtifactCandidate } from '../distribution/npm/stage';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '../runtime/resolveExecutablePluginRuntimeRegistry';
import { loadRetainedAgentRuntimeLeaf } from '../runtime/runner/loadRetainedAgentRuntimeLeaf';
import { resolvePluginStorePaths } from '../store/paths';
import { seedCurrentLocalPathPluginFixture } from '../store/registry/currentState.testkit';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { packLocalPlugin } from './pack';

const fixtureRoot = fileURLToPath(new URL(
  '../testkit/fixtures/packed-external-voice-provider',
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

  it('packs, stages, and runs the dependency-closed public fixture through its attested Agent runner', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-packed-voice-public-contract-'));
    const archivePath = join(parent, 'packed-voice.tgz');
    const installRoot = join(parent, 'installed');
    const runtimeHome = join(parent, 'runtime-home');
    let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;
    let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
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
      expect(staged.candidate.manifest.value.entrypoints).toEqual({
        daemon: './dist/daemon.js',
        development: './src/voiceDaemon.ts',
      });

      expect(staged.candidate.generatedUiArtifacts.artifactIds)
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
