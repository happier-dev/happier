import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { mkdtemp, readdir, rm, access, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { resolveAgentCliManagedCommandPathForRuntime, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { execFileWithDeadline, isPidPresent, ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { create as createTar } from 'tar';
import type { AgentInstallJobOutcome } from '@happier-dev/protocol';
import { PluginAgentContributionV2Schema, PluginManifestV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as antigravityManifest } from '@happier-dev/plugins-antigravity/manifest';
import cliTestConfig from '../../../vitest.config';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { createAgentInstallJobOwner as createProductionAgentInstallJobOwner, type AgentInstallJobOwner } from './agentInstallJobOwner';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';
import { DaemonAgentInstallReadRequestSchema, DaemonAgentInstallReadResponseSchema, DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';

const fixtureWaitTimeout = cliTestConfig.test?.testTimeout;
if (typeof fixtureWaitTimeout !== 'number') throw new Error('CLI unit test timeout must be configured');

function createAgentInstallJobOwner(options: Parameters<typeof createProductionAgentInstallJobOwner>[0]) {
  // These fixtures own no live sessions; destructive operations require an observed runner set.
  return createProductionAgentInstallJobOwner({ readTrackedSessions: () => [], ...options });
}

test.skipIf(process.platform === 'win32')('ordinary install refuses replacing existing managed bytes for a live Agent but permits its first acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-live-agent-repair-'));
  const binary = Buffer.from('#!/bin/sh\nprintf "fixture-live 1.2.3\\n"\n');
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-length': binary.length }); response.end(binary); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let owner: AgentInstallJobOwner | undefined;
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const spec: AgentCliRuntimeDescriptor = { id: 'fixture-live', title: 'Fixture live', binaryName: 'fixture-live',
      sourcePreferenceDefault: 'managed-first', manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/live', binaryName: 'fixture-live' } };
    const env = { NODE_ENV: process.env.NODE_ENV, HAPPIER_HOME_DIR: root, HOME: root, PATH: '' };
    owner = createAgentInstallJobOwner({ env, readRegistry: () => registryWith(spec), readTrackedSessions: () => [{
      trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: root,
        runtimeDescriptorV1: { v: 1, agentId: spec.id, agent: {} } },
    }], installerDeps: { fetchGitHubLatestRelease: async () => ({ assets: [{
      name: `fixture-live-${process.platform}-${process.arch}`, browser_download_url: `http://127.0.0.1:${address.port}/binary`,
      digest: `sha256:${createHash('sha256').update(binary).digest('hex')}`,
    }] }) } });
    const first = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(await outcome(owner, first.jobId)).toEqual({ kind: 'succeeded', version: '1.2.3' });
    await chmod(resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: env }), 0o644);
    const repair = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(repair.ok).toBe(true); if (!repair.ok) return;
    expect(await outcome(owner, repair.jobId)).toMatchObject({ kind: 'failed', code: 'in_use' });
  } finally {
    await owner?.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function stopFixture(owner: AgentInstallJobOwner | undefined, allowTerminationFailure = false): Promise<void> {
  try {
    await owner?.shutdown();
  } catch (error) {
    if (!allowTerminationFailure || !(error instanceof ExecFileTerminationError)) throw error;
  }
}

const httpsFixture = vi.hoisted(() => ({ origin: '' }));
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  const http = await import('node:http');
  return { ...actual, request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    // Only the external HTTPS transport is substituted; schema, download,
    // digest verification, extraction and promotion remain real.
    if (url.hostname !== 'agent-job-fixture.invalid') return actual.request(url, options, callback);
    if (!httpsFixture.origin) throw new Error('Missing isolated HTTPS fixture transport');
    return http.request(new URL(url.pathname, httpsFixture.origin), options, callback);
  } };
});

async function outcome(owner: AgentInstallJobOwner, jobId: string): Promise<AgentInstallJobOutcome | null> {
  let result: AgentInstallJobOutcome | null = null;
  await vi.waitFor(() => {
    const read = owner.read({ jobId, cursor: 0 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.done).toBe(true);
    result = read.outcome;
  }, { timeout: fixtureWaitTimeout });
  return result;
}

function registryWith(runtimeSpec: AgentCliRuntimeDescriptor) {
  // Declarative contributed manifest data, projected through the same runtime
  // descriptor owner as an installed plugin. No installer or job logic is mocked.
  return { agents: [{ id: runtimeSpec.id, runtimeSpec, pluginId: 'fixture.plugin' }], managedDependencies: [] };
}

test('admits the documented lowercase Oh My Pi name using its canonical runtime identity', async () => {
  const spec: AgentCliRuntimeDescriptor = { id: 'ohMyPi', title: 'Oh My Pi', binaryName: 'omp',
    sourcePreferenceDefault: 'system-first', manualInstallKind: 'none', manualInstallRecipes: {},
    acceptsJavaScriptFileOverride: false, managedInstall: null };
  const owner = createAgentInstallJobOwner({ env: { PATH: '' }, readRegistry: () => registryWith(spec) });
  try {
    const started = owner.start({ agentId: 'ohmypi', intent: 'install', consent: { vendorRecipe: false } });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    expect(owner.list()).toMatchObject({ ok: true, jobs: [expect.objectContaining({ agentId: 'ohMyPi' })] });
  } finally { await owner.shutdown(); }
});

test('an exhausted GitHub REST install retains a typed rate-limit outcome and reset time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-ratelimit-'));
  const spec: AgentCliRuntimeDescriptor = {
    id: 'fixture-limit', title: 'Fixture limit', binaryName: 'fixture-limit',
    sourcePreferenceDefault: 'managed-first', acceptsJavaScriptFileOverride: false,
    manualInstallKind: 'none', manualInstallRecipes: null,
    managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/limit', binaryName: 'fixture-limit' },
  };
  const owner = createAgentInstallJobOwner({
    env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' }, readRegistry: () => registryWith(spec),
    installerDeps: { fetchGitHubLatestRelease: (params) => fetchGitHubLatestRelease({ ...params,
      fetchImpl: async () => new Response('', { status: 403, headers: {
        'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792364400',
      } }),
    }) },
  });
  try {
    const started = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    if (!started.ok) throw new Error('Expected install admission');
    expect(await outcome(owner, started.jobId)).toMatchObject({ kind: 'failed', code: 'rate_limited',
      message: expect.stringContaining('2026-10-18T23:00:00.000Z'),
    });
    expect(DaemonAgentInstallReadResponseSchema.safeParse(owner.read({ jobId: started.jobId, cursor: 0 })).success).toBe(true);
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('archive total limit survives the update job boundary and preserves the previous runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-archive-limit-'));
  let owner: AgentInstallJobOwner | undefined;
  const binaryName = 'fixture-archive-limit';
  const previousBinary = '#!/bin/sh\nprintf "fixture-archive-limit 1.0.0\\n"\n';
  const nextBinary = Buffer.from(previousBinary.replace('1.0.0', '2.0.0'));
  const unusedResource = Buffer.alloc(nextBinary.length, 0x78);
  const assetName = `${binaryName}-${process.platform}-${process.arch}.tar.gz`;
  const payloadDir = join(root, 'payload');
  await mkdir(payloadDir);
  await writeFile(join(payloadDir, binaryName), nextBinary, { mode: 0o755 });
  await writeFile(join(payloadDir, 'unused-resource'), unusedResource);
  const archivePath = join(root, assetName);
  await createTar({ cwd: payloadDir, gzip: true, portable: true, file: archivePath }, [binaryName, 'unused-resource']);
  const archive = await readFile(archivePath);
  let origin = '';
  const server = createServer((request, response) => {
    if (request.url === '/archive') {
      response.writeHead(200, { 'content-length': archive.length });
      response.end(archive);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ assets: [{
      name: assetName, browser_download_url: `${origin}/archive`,
      digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    origin = `http://127.0.0.1:${address.port}`;
    const spec: AgentCliRuntimeDescriptor = {
      id: binaryName, title: 'Fixture archive limit', binaryName,
      sourcePreferenceDefault: 'managed-first', manualInstallKind: 'none', manualInstallRecipes: null,
      acceptsJavaScriptFileOverride: false,
      managedInstall: {
        kind: 'github_release_binary', githubRepo: 'fixture/archive-limit', binaryName,
        archiveEntriesByPlatform: {
          darwin: [{ archivePath: binaryName, destinationPath: `bin/${binaryName}` }],
          linux: [{ archivePath: binaryName, destinationPath: `bin/${binaryName}` }],
          win32: [{ archivePath: binaryName, destinationPath: `bin/${binaryName}.exe` }],
        },
        // Each file fits; only their combined size exceeds the total budget.
        // The unselected resource still counts toward that same archive budget.
        archiveExtractionLimits: { maxFileBytes: nextBinary.length, maxExpandedBytes: nextBinary.length + unusedResource.length - 1 },
      },
    };
    const env = { NODE_ENV: process.env.NODE_ENV, HOME: root, HAPPIER_HOME_DIR: root, PATH: '' };
    const installedPath = resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: env });
    await mkdir(dirname(installedPath), { recursive: true });
    await writeFile(installedPath, previousBinary, { mode: 0o755 });
    owner = createAgentInstallJobOwner({ env, readRegistry: () => registryWith(spec), installerDeps: {
      // Redirect only GitHub HTTP; release parsing, hashing, extraction, install
      // classification, invoke translation and job settlement remain real.
      fetchGitHubLatestRelease: (params) => fetchGitHubLatestRelease({ ...params,
        fetchImpl: (url, init) => fetch(`${origin}${new URL(String(url)).pathname}`, init),
      }),
    } });
    const started = owner.start({ agentId: spec.id, intent: 'update', consent: { vendorRecipe: false } });
    if (!started.ok) throw new Error('Expected update admission');
    const completed = await outcome(owner, started.jobId);
    expect(completed, JSON.stringify(completed)).toMatchObject({
      kind: 'failed', code: 'archive_expanded_byte_limit', stepId: `cli.${spec.id}`,
    });
    expect(DaemonAgentInstallReadResponseSchema.parse(owner.read({ jobId: started.jobId, cursor: 0 }))).toMatchObject({
      ok: true, done: true, outcome: { kind: 'failed', code: 'archive_expanded_byte_limit' },
      events: expect.arrayContaining([{ t: 'log', line: '[release-runtime] archive exceeds expanded-byte limit' }]),
    });
    expect(await readFile(installedPath, 'utf8')).toBe(previousBinary);
  } finally {
    await stopFixture(owner);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('plugin agent job streams bytes, rejects fresh closed-drain starts and preserves accepted installation custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-'));
  let owner: AgentInstallJobOwner | undefined;
  const binary = Buffer.from('#!/bin/sh\nprintf "fixture-agent 1.2.3\\n"\n');
  const transport: { response: ServerResponse | null } = { response: null };
  const admissionDrain = createDaemonAdmissionDrain();
  let releaseRequests = 0;
  const server = createServer((_req, res) => { transport.response = res; res.writeHead(200, { 'content-length': binary.length }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const runtimeSpec: AgentCliRuntimeDescriptor = {
      id: 'fixture-plugin-agent', title: 'Fixture Plugin Agent', binaryName: 'fixture-agent',
      sourcePreferenceDefault: 'system-first', manualInstallKind: 'none', manualInstallRecipes: null,
      acceptsJavaScriptFileOverride: false,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/plugin', binaryName: 'fixture-agent' },
    };
    owner = createAgentInstallJobOwner({
      admissionDrain,
      readRegistry: () => ({
        agents: [{ ...registryWith(runtimeSpec).agents[0], hostAccess: {
          required: [{ id: 'optional-mode-process', capability: 'process', reason: 'Permit a different runtime mode', scope: {
            executables: [{ kind: 'managedDependency', id: 'optional-mode-adapter' }],
          } }], optional: [],
        } }],
        managedDependencies: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.plugin',
          definition: { id: 'optional-mode-adapter', title: 'Optional runtime mode', executable: 'optional-adapter',
            sources: [{ kind: 'vendorRecipe', recipeId: 'optional-adapter' }] },
        }],
      }),
      env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: join(root, 'empty-path') },
      installerDeps: {
        // The release-service transport is the only substituted system boundary.
        fetchGitHubLatestRelease: async () => { releaseRequests += 1; return { assets: [{
          name: `fixture-agent-${process.platform}-${process.arch}`,
          browser_download_url: `http://127.0.0.1:${address.port}/binary`,
          digest: `sha256:${createHash('sha256').update(binary).digest('hex')}`,
        }] }; },
      },
    });
    admissionDrain.beginUnusedStopDrain();
    expect(owner.start({ agentId: runtimeSpec.id, intent: 'install', consent: { vendorRecipe: false } }))
      .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    expect(owner.list()).toEqual({ ok: true, jobs: [] });
    expect(releaseRequests).toBe(0);
    admissionDrain.resumeUnusedStop();
    const started = owner.start({ agentId: runtimeSpec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    admissionDrain.beginUnusedStopDrain();
    expect(owner.start({ agentId: runtimeSpec.id, intent: 'update', consent: { vendorRecipe: false } })).toEqual(started);
    await vi.waitFor(() => {
      const read = owner!.read({ jobId: started.jobId, cursor: 0 });
      expect(transport.response !== null || (read.ok && read.done)).toBe(true);
    }, { timeout: fixtureWaitTimeout });
    if (!transport.response) expect(await outcome(owner, started.jobId)).toEqual({ kind: 'succeeded', version: '1.2.3' });
    transport.response?.end(binary);
    expect(await outcome(owner, started.jobId)).toEqual({ kind: 'succeeded', version: '1.2.3' });
    const read = owner.read({ jobId: started.jobId, cursor: 0 });
    expect(read).toMatchObject({ ok: true, done: true,
      steps: expect.arrayContaining([{ stepId: 'verify', label: 'Check it runs', state: 'done' }]),
      progress: [{ stepId: `cli.${runtimeSpec.id}`, bytesDone: binary.length, bytesTotal: binary.length }],
      events: expect.arrayContaining([
      { t: 'progress', stepId: `cli.${runtimeSpec.id}`, bytesDone: binary.length, bytesTotal: binary.length },
      { t: 'step', stepId: 'verify', label: 'Check it runs', state: 'done' },
    ]) });
    if (read.ok) expect(owner.read({ jobId: started.jobId, cursor: read.nextCursor })).toMatchObject({ events: [], done: true });
    expect(owner.list()).toMatchObject({ jobs: [expect.objectContaining({ jobId: started.jobId, done: true })] });
    expect(owner.start({ agentId: runtimeSpec.id, intent: 'update', consent: { vendorRecipe: false } }))
      .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
  } finally {
    await stopFixture(owner);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('manual-only agent job exposes install_not_available with its guide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-manual-'));
  let owner: AgentInstallJobOwner | undefined;
  try {
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-manual', title: 'Fixture Manual', binaryName: 'fixture-manual',
      sourcePreferenceDefault: 'system-first', manualInstallKind: 'command', manualInstallRecipes: null,
      managedInstall: null, acceptsJavaScriptFileOverride: false, installGuideUrl: 'https://example.com/guide',
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' } });
    const activityEdges: unknown[] = [];
    const currentOwner = owner;
    const unsubscribe = owner.activity.subscribe(() => activityEdges.push(currentOwner.activity.read()));
    const start = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(start.ok).toBe(true);
    if (start.ok) {
      expect(owner.activity.read()).toEqual({ coverage: 'complete', items: [{ category: 'setup',
        ownerRef: start.jobId, attribution: { kind: 'unknown' }, state: 'active' }] });
      expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'install_not_available', guideUrl: spec.installGuideUrl });
      expect(owner.activity.read()).toMatchObject({ items: [{ ownerRef: start.jobId, state: 'settled' }] });
      expect(activityEdges).toContainEqual(expect.objectContaining({ items: [expect.objectContaining({ state: 'settled' })] }));
    }
    unsubscribe();
    const retry = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(retry.ok).toBe(true);
    if (retry.ok && start.ok) {
      expect(retry.jobId).not.toBe(start.jobId);
      // A new running attempt does not remove the previous reconnection result.
      expect(owner.read({ jobId: start.jobId, cursor: 0 })).toMatchObject({ ok: true, done: true });
      await outcome(owner, retry.jobId);
      expect(owner.list()).toMatchObject({ jobs: [expect.objectContaining({ jobId: retry.jobId })] });
      expect(owner.read({ jobId: start.jobId, cursor: 0 })).toMatchObject({ ok: false, errorCode: 'job_not_found' });
    }
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown agents and agents without runtime metadata are rejected without admitting jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-unknown-'));
  let owner: AgentInstallJobOwner | undefined;
  try {
    owner = createAgentInstallJobOwner({ readRegistry: () => ({ agents: [{ id: 'no-cli' }] }), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' } });
    for (const agentId of ['unknown', 'no-cli']) {
      expect(owner.start({ agentId, intent: 'install', consent: { vendorRecipe: true } })).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    }
    expect(owner.list()).toEqual({ ok: true, jobs: [] });
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('vendor recipe consent fails at the installer owner before executing a command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-consent-'));
  let owner: AgentInstallJobOwner | undefined;
  try {
    const marker = join(root, 'executed');
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-recipe', title: 'Fixture Recipe', binaryName: 'fixture-recipe',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: { linux: [{ cmd: '/bin/sh', args: ['-c', `touch '${marker}'`] }], darwin: [{ cmd: '/bin/sh', args: ['-c', `touch '${marker}'`] }] },
      acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' } });
    const start = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'consent_required', stepId: `cli.${spec.id}` });
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32').each([
  { networkCode: 'ENOTFOUND', intent: 'install' }, { networkCode: 'ETIMEDOUT', intent: 'install' },
  { networkCode: 'ENOTFOUND', intent: 'update' }, { networkCode: 'ETIMEDOUT', intent: 'update' },
] as const)('release transport failures retain their network cause ($intent $networkCode)', async ({ networkCode, intent }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-download-'));
  let owner: AgentInstallJobOwner | undefined;
  try {
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-download', title: 'Fixture Download', binaryName: 'fixture-download',
      sourcePreferenceDefault: 'system-first', manualInstallKind: 'none', manualInstallRecipes: null,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/download', binaryName: 'fixture-download' },
      acceptsJavaScriptFileOverride: false,
    };
    const env = { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' };
    if (intent === 'update') {
      const command = resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: env });
      await mkdir(join(command, '..'), { recursive: true });
      await writeFile(command, '#!/bin/sh\nprintf "fixture-download 1.0.0\\n"\n', { mode: 0o755 });
    }
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env, installerDeps: {
      fetchGitHubLatestRelease: async () => { throw Object.assign(new Error('Fixture release transport unavailable'), { code: networkCode }); },
    } });
    const start = owner.start({ agentId: spec.id, intent, consent: { vendorRecipe: false } });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'download_failed', stepId: `cli.${spec.id}`,
      failureCause: { phase: 'agent.install.download', errorCode: networkCode } });
    expect(owner.read({ jobId: start.jobId, cursor: 0 })).toMatchObject({ events: expect.arrayContaining([
      { t: 'step', stepId: `cli.${spec.id}`, label: spec.title, state: 'failed' },
    ]) });
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('cancel waits for download cleanup before releasing the agent job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-cancel-'));
  let owner: AgentInstallJobOwner | undefined;
  let response: ServerResponse | null = null;
  const server = createServer((_req, res) => { response = res; res.writeHead(200); res.write('partial'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-cancel', title: 'Fixture Cancel', binaryName: 'fixture-cancel',
      sourcePreferenceDefault: 'system-first', manualInstallKind: 'none', manualInstallRecipes: null,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/cancel', binaryName: 'fixture-cancel' },
      acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' }, installerDeps: {
      fetchGitHubLatestRelease: async () => ({ assets: [{ name: `fixture-cancel-${process.platform}-${process.arch}`, browser_download_url: `http://127.0.0.1:${address.port}`, digest: `sha256:${'0'.repeat(64)}` }] }),
    } });
    const start = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await vi.waitFor(() => expect(response).not.toBeNull(), { timeout: fixtureWaitTimeout });
    await expect(owner.cancel({ jobId: start.jobId })).resolves.toEqual({ ok: true });
    expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'cancelled' });
    const scratch = await readdir(join(root, 'tools', 'providers', spec.id));
    expect(scratch.filter((name) => name.startsWith('.install') || name === 'current')).toEqual([]);
  } finally {
    await stopFixture(owner);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('vendor cancellation waits until its descendant process is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-tree-'));
  let owner: AgentInstallJobOwner | undefined;
  let descendantPid: number | null = null;
  try {
    const pidFile = join(root, 'child-pid');
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-tree', title: 'Fixture Tree', binaryName: 'fixture-tree',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        linux: [{ cmd: '/bin/sh', args: ['-c', `/bin/sleep 100 & printf '%s' "$!" > '${pidFile}'; wait`] }],
        darwin: [{ cmd: '/bin/sh', args: ['-c', `/bin/sleep 100 & printf '%s' "$!" > '${pidFile}'; wait`] }],
      },
      acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' } });
    const start = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: true } });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await vi.waitFor(async () => {
      descendantPid = Number(await readFile(pidFile, 'utf8'));
      expect(isPidPresent(descendantPid)).toBe(true);
    }, { timeout: fixtureWaitTimeout });
    const cancellation = owner.cancel({ jobId: start.jobId });
    expect(owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: true } })).toEqual(start);
    await cancellation;
    expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'cancelled' });
    expect(descendantPid && isPidPresent(descendantPid)).toBe(false);
  } finally {
    await stopFixture(owner);
    if (descendantPid && isPidPresent(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Fixture process may have just exited. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32').each(['fresh', 'outdated', 'refused', 'failed'] as const)(
  'first Session readiness installs or updates the chosen Agent on a %s guest', async state => {
    const root = await mkdtemp(join(tmpdir(), 'agent-job-first-session-'));
    let owner: AgentInstallJobOwner | undefined;
    try {
      const bin = join(root, '.local', 'bin');
      await mkdir(bin, { recursive: true });
      const executable = join(bin, 'fixture-ready');
      const versionFile = join(root, 'version');
      const script = `#!/bin/sh\nif [ "$1" = update ]; then printf '2.0.0' > '${versionFile}'; else printf 'fixture-ready '; /bin/cat '${versionFile}'; fi\n`;
      if (state === 'outdated' || state === 'refused') {
        await writeFile(executable, script, { mode: 0o755 });
        await writeFile(versionFile, '1.0.0');
      }
      const spec: AgentCliRuntimeDescriptor = {
        id: 'fixture-ready', title: 'Fixture ready', binaryName: 'fixture-ready',
        sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'vendor_recipe',
        manualInstallRecipes: { [process.platform]: [{ cmd: '/bin/sh', args: ['-c',
          state === 'failed' ? 'exit 1' : `/bin/cat > '${executable}' <<'AGENT'\n${script}\nAGENT\n/bin/chmod +x '${executable}'; printf '2.0.0' > '${versionFile}'`] }] },
        nativeUpdate: { args: ['update'], installPaths: ['.local/bin/fixture-ready'] }, acceptsJavaScriptFileOverride: false,
      };
      owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec),
        env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: bin } });
      const request = DaemonAgentInstallStartRequestSchema.safeParse({ agentId: spec.id,
        intent: state === 'outdated' || state === 'refused' ? 'update' : 'install', consent: { vendorRecipe: state !== 'refused' } });
      expect(request.success).toBe(true);
      if (!request.success) return;
      const started = owner.start(request.data);
      expect(started).toMatchObject({ ok: true });
      if (!started.ok) return;
      const read = await owner.read(DaemonAgentInstallReadRequestSchema.parse({ jobId: started.jobId, cursor: 0, waitForTerminal: true }));
      expect(read).toMatchObject({ ok: true, done: true });
      if (!read.ok) return;
      expect(read.outcome).toMatchObject(state === 'refused'
        ? { kind: 'failed', code: 'consent_required' } : state === 'failed'
          ? { kind: 'failed', code: 'install_failed' } : { kind: 'succeeded', version: '2.0.0' });
      if (state === 'failed') await expect(access(versionFile)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(versionFile, 'utf8')).toBe(state === 'refused' ? '1.0.0' : '2.0.0');
    } finally {
      await stopFixture(owner);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')('update runs and verifies the existing vendor executable through the canonical update owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-update-'));
  let owner: AgentInstallJobOwner | undefined;
  try {
    const bin = join(root, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    const versionFile = join(root, 'version');
    await writeFile(versionFile, '1.0.0');
    await writeFile(join(bin, 'fixture-update'), `#!/bin/sh\nif [ "$1" = update ]; then printf '2.0.0' > '${versionFile}'; else printf 'fixture-update '; /bin/cat '${versionFile}'; fi\n`, { mode: 0o755 });
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-update', title: 'Fixture Update', binaryName: 'fixture-update',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: { linux: [{ cmd: '/bin/sh', args: ['-c', 'exit 0'] }], darwin: [{ cmd: '/bin/sh', args: ['-c', 'exit 0'] }] },
      nativeUpdate: { args: ['update'], installPaths: ['.local/bin/fixture-update'] },
      acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: bin } });
    const denied = owner.start({ agentId: spec.id, intent: 'update', consent: { vendorRecipe: false } });
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(await outcome(owner, denied.jobId)).toMatchObject({ kind: 'failed', code: 'consent_required' });
    expect(await readFile(versionFile, 'utf8')).toBe('1.0.0');
    const start = owner.start({ agentId: spec.id, intent: 'update', consent: { vendorRecipe: true } });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(await outcome(owner, start.jobId)).toEqual({ kind: 'succeeded', version: '2.0.0' });
    expect(await readFile(versionFile, 'utf8')).toBe('2.0.0');
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32').each(['local', 'qualified', 'cross-plugin'] as const)('job installs and checks the %s plugin dependency through its projected installable identity', async (referenceKind) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-dependency-'));
  let owner: AgentInstallJobOwner | undefined;
  const binary = Buffer.from('#!/bin/sh\nprintf "fixture-agent 1.2.3\\n"\n');
  const dependencyBytes = '#!/bin/sh\nprintf "fixture-companion 2.0.0\\n"\n';
  await writeFile(join(root, 'companion'), dependencyBytes);
  const archivePath = join(root, 'companion.tar.gz');
  await createTar({ cwd: root, gzip: true, file: archivePath }, ['companion']);
  const archive = await readFile(archivePath);
  const server = createServer((req, res) => {
    const bytes = req.url === '/companion.tar.gz' ? archive : binary;
    res.writeHead(200, { 'content-length': bytes.length });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const origin = `http://127.0.0.1:${address.port}`;
    httpsFixture.origin = origin;
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-dependency', title: 'Fixture Dependency', binaryName: 'fixture-dependency',
      sourcePreferenceDefault: 'system-first', manualInstallKind: 'none', manualInstallRecipes: null,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/dependency', binaryName: 'fixture-dependency' },
      acceptsJavaScriptFileOverride: false,
    };
    const dependency = {
      provenance: 'external', source: { kind: 'path' }, pluginId: referenceKind === 'cross-plugin' ? 'fixture.tools' : 'fixture.plugin', manifestPath: join(root, 'plugin.json'),
      definition: {
        id: 'companion-local', title: 'Fixture companion', executable: 'companion', sources: [{
          kind: 'pinnedArchive', installId: 'dep.fixture.companion', version: '2.0.0',
          assetsByPlatform: { [`${process.platform}-${process.arch}`]: {
            archiveUrl: 'https://agent-job-fixture.invalid/companion.tar.gz', sha256: createHash('sha256').update(archive).digest('hex'), executableSubpath: 'companion',
          } },
        }],
      },
    } satisfies ResolvedInstallableContribution;
    const declaration = PluginManifestV2Schema.parse(antigravityManifest).contributes.agents.find((agent) => agent.id === 'antigravity');
    if (!declaration || !('runtime' in declaration) || declaration.runtime.kind !== 'acp') throw new Error('Missing canonical ACP declaration fixture');
    const rich = { provenance: 'external' as const, definition: declaration };
    owner = createAgentInstallJobOwner({
      readRegistry: () => ({
        agents: [{ ...registryWith(spec).agents[0], richDefinition: {
          ...rich, definition: PluginAgentContributionV2Schema.parse({ ...rich.definition, runtime: { ...rich.definition.runtime, transport: { kind: 'stdio', executable: { kind: 'managedDependency', id: referenceKind === 'local' ? 'companion-local' : { pluginId: dependency.pluginId, localId: 'companion-local' } } } } }),
        }, hostAccess: { required: [{ id: 'companion-process', capability: 'process', reason: 'Run companion', scope: { executables: [{ kind: 'managedDependency', id: 'companion-local' }] } }], optional: [] } }],
        managedDependencies: [dependency],
      }),
      env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' },
      installerDeps: { fetchGitHubLatestRelease: async () => ({ assets: [{ name: `fixture-dependency-${process.platform}-${process.arch}`, browser_download_url: `${origin}/cli`, digest: `sha256:${createHash('sha256').update(binary).digest('hex')}` }] }) },
    });
    const start = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(await outcome(owner, start.jobId)).toEqual({ kind: 'succeeded', version: '1.2.3' });
    expect(await readFile(join(root, 'tools', 'dep.fixture.companion', 'current', 'companion'), 'utf8')).toBe(dependencyBytes);
    const read = owner.read({ jobId: start.jobId, cursor: 0 });
    expect(read).toMatchObject({ events: expect.arrayContaining([
      { t: 'step', stepId: 'dep.fixture.companion', label: 'Fixture companion', state: 'done' },
      { t: 'progress', stepId: 'dep.fixture.companion', bytesDone: archive.length, bytesTotal: archive.length },
    ]) });
    if (read.ok) expect(read.events.filter((event) => event.t === 'step' && event.stepId === 'dep.fixture.companion' && event.state === 'running')).toHaveLength(1);
  } finally {
    await stopFixture(owner);
    httpsFixture.origin = '';
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared unsupported dependency fails before the agent CLI acquires anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-platform-'));
  let owner: AgentInstallJobOwner | undefined;
  try {
  const spec: AgentCliRuntimeDescriptor = {
    id: 'fixture-platform', title: 'Fixture Platform', binaryName: 'fixture-platform',
    sourcePreferenceDefault: 'system-first', managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/platform', binaryName: 'fixture-platform' },
    manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
  };
  const releaseBoundary = vi.fn(async () => { throw new Error('No acquisition was authorized'); });
  const declaration = PluginManifestV2Schema.parse(antigravityManifest).contributes.agents.find((agent) => agent.id === 'antigravity');
  if (!declaration || !('runtime' in declaration) || declaration.runtime.kind !== 'acp') throw new Error('Missing canonical ACP declaration fixture');
  owner = createAgentInstallJobOwner({
    readRegistry: () => ({
      agents: [{ ...registryWith(spec).agents[0], richDefinition: { provenance: 'external', definition: PluginAgentContributionV2Schema.parse({
        ...declaration, runtime: { ...declaration.runtime, transport: { kind: 'stdio', executable: { kind: 'managedDependency', id: 'companion' } } },
      }) } }],
      managedDependencies: [{
        provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.plugin', manifestPath: '/fixture/plugin.json',
        definition: { id: 'companion', title: 'Fixture companion', executable: 'companion', sources: [{ kind: 'pinnedArchive', installId: 'dep.fixture.companion', version: '2.0.0', assetsByPlatform: { 'darwin-arm64': { archiveUrl: 'https://example.invalid/never-download.tar.gz', sha256: '0'.repeat(64), executableSubpath: 'companion' } } }] },
      }],
    }),
    platform: 'darwin', arch: 'x64', env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' }, installerDeps: { fetchGitHubLatestRelease: releaseBoundary },
  });
  const start = owner.start({ agentId: spec.id, intent: 'install', consent: { vendorRecipe: false } });
  expect(start.ok).toBe(true);
  if (start.ok) expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'unsupported_platform' });
  expect(releaseBoundary).not.toHaveBeenCalled();
  } finally {
    await stopFixture(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('daemon shutdown cancels downloads, awaits scratch cleanup and closes admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-shutdown-'));
  let owner: AgentInstallJobOwner | undefined;
  let response: ServerResponse | null = null;
  const server = createServer((_req, res) => { response = res; res.writeHead(200); res.write('partial'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-shutdown', title: 'Fixture Shutdown', binaryName: 'fixture-shutdown',
      sourcePreferenceDefault: 'system-first', manualInstallKind: 'none', manualInstallRecipes: null,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/shutdown', binaryName: 'fixture-shutdown' },
      acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' }, installerDeps: {
      fetchGitHubLatestRelease: async () => ({ assets: [{ name: `fixture-shutdown-${process.platform}-${process.arch}`, browser_download_url: `http://127.0.0.1:${address.port}`, digest: `sha256:${'0'.repeat(64)}` }] }),
    } });
    const input = { agentId: spec.id, intent: 'install' as const, consent: { vendorRecipe: false } };
    const start = owner.start(input);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await vi.waitFor(() => expect(response).not.toBeNull(), { timeout: fixtureWaitTimeout });
    const shutdown = owner.shutdown();
    expect(owner.start(input)).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    await shutdown;
    expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'cancelled' });
    expect((await readdir(join(root, 'tools', 'providers', spec.id))).filter((name) => name.startsWith('.install') || name === 'current')).toEqual([]);
  } finally {
    await stopFixture(owner);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('failed process termination is visible and excludes another install writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-cleanup-failure-'));
  let owner: AgentInstallJobOwner | undefined;
  const processBoundary: { child: ChildProcess | null } = { child: null };
  try {
    const marker = join(root, 'running');
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-cleanup', title: 'Fixture Cleanup', binaryName: 'fixture-cleanup',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        linux: [{ cmd: '/bin/sh', args: ['-c', `printf started > '${marker}'; exec /bin/sleep 100`] }],
        darwin: [{ cmd: '/bin/sh', args: ['-c', `printf started > '${marker}'; exec /bin/sleep 100`] }],
      }, acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({
      readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: '' },
      installerDeps: {
        // Simulate denial at the OS termination boundary while keeping the
        // actual command, executor and installer lifecycle real.
        execFileWithDeadline: (command, args, options) => execFileWithDeadline(command, args, { ...options, terminateOnAbort: async (process) => {
          processBoundary.child = process;
          throw new Error('Fixture process termination denied');
        } }),
      },
    });
    const input = { agentId: spec.id, intent: 'install' as const, consent: { vendorRecipe: true } };
    const start = owner.start(input);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await vi.waitFor(() => access(marker), { timeout: fixtureWaitTimeout });
    expect(await owner.cancel({ jobId: start.jobId })).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'install_failed' });
    expect(owner.activity.read()).toEqual({ coverage: 'complete', items: [{ category: 'setup',
      ownerRef: start.jobId, attribution: { kind: 'unknown' }, state: 'unknown' }] });
    expect(owner.start(input)).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    await expect(owner.shutdown()).rejects.toMatchObject({ name: 'ExecFileTerminationError' });
  } finally {
    await stopFixture(owner, true);
    const child = processBoundary.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once('close', resolve));
      await terminateProcessTree(child);
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32').each([false, true])('version verification cancellation preserves process containment failures: denied=%s', async (terminationDenied) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-job-probe-cancel-'));
  let owner: AgentInstallJobOwner | undefined;
  let descendantPid: number | null = null;
  const processBoundary: { child: ChildProcess | null } = { child: null };
  try {
    const bin = join(root, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    const pidFile = join(root, 'probe-child');
    await writeFile(join(bin, 'fixture-probe'), `#!/bin/sh\n/bin/sleep 100 & printf '%s' "$!" > '${pidFile}'; wait\n`, { mode: 0o755 });
    const spec: AgentCliRuntimeDescriptor = {
      id: 'fixture-probe', title: 'Fixture Probe', binaryName: 'fixture-probe', sourcePreferenceDefault: 'system-first',
      managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
    };
    owner = createAgentInstallJobOwner({ readRegistry: () => registryWith(spec), env: { HOME: root, HAPPIER_HOME_DIR: root, PATH: bin },
      ...(terminationDenied ? { installerDeps: { execFileWithDeadline: (command: string, args: readonly string[], options: Parameters<typeof execFileWithDeadline>[2]) =>
        execFileWithDeadline(command, args, { ...options, terminateOnAbort: async (child) => {
          processBoundary.child = child;
          throw new Error('Fixture version process termination denied');
        } }) } } : {}),
    });
    const input = { agentId: spec.id, intent: 'install' as const, consent: { vendorRecipe: false } };
    const start = owner.start(input);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await vi.waitFor(async () => {
      descendantPid = Number(await readFile(pidFile, 'utf8'));
      expect(isPidPresent(descendantPid)).toBe(true);
    }, { timeout: fixtureWaitTimeout });
    const cancelled = await owner.cancel({ jobId: start.jobId });
    if (terminationDenied) {
      expect(cancelled).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
      expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'install_failed', stepId: 'verify' });
      expect(owner.start(input)).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
      await expect(owner.shutdown()).rejects.toMatchObject({ name: 'ExecFileTerminationError' });
    } else {
      expect(cancelled).toEqual({ ok: true });
      expect(await outcome(owner, start.jobId)).toMatchObject({ kind: 'failed', code: 'cancelled', stepId: 'verify' });
      expect(descendantPid && isPidPresent(descendantPid)).toBe(false);
    }
  } finally {
    await stopFixture(owner, terminationDenied);
    const child = processBoundary.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once('close', resolve));
      await terminateProcessTree(child);
      await closed;
    }
    if (descendantPid && isPidPresent(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Fixture process may have just exited. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
