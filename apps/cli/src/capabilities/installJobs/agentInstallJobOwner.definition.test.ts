import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcpBackendDefinitionV1Schema, type AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { AgentInstallJobOutcome } from '@happier-dev/protocol';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import type { TrackedSession } from '@/daemon/types';
import { createDaemonPluginRegistryProjectionInvalidation } from '@/daemon/pluginRegistryProjectionInvalidation';
import type { DaemonState } from '@/api/types';
import { resolveAcpLaunch } from '@/agent/acp/catalog/configured/resolveAcpLaunch';
import { createAgentInstallJobOwner, type AgentInstallJobOwner } from './agentInstallJobOwner';
import cliTestConfig from '../../../vitest.config';

const fixtureTimeout = cliTestConfig.test?.testTimeout;
if (typeof fixtureTimeout !== 'number') throw new Error('Missing CLI fixture timeout');
const transport = vi.hoisted(() => ({ origin: '' }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  const http = await import('node:http');
  return { ...actual, request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    // Only the external HTTPS transport is substituted; installer and launch validation remain real.
    if (url.hostname !== 'definition-job-fixture.invalid') return actual.request(url, options, callback);
    return http.request(new URL(url.pathname, transport.origin), options, callback);
  } };
});

async function terminal(owner: AgentInstallJobOwner, jobId: string, accountId?: string): Promise<AgentInstallJobOutcome | null> {
  let result: AgentInstallJobOutcome | null = null;
  await vi.waitFor(() => {
    const read = owner.read({ jobId, cursor: 0 }, accountId);
    expect(read.ok && read.done).toBe(true);
    if (read.ok) result = read.outcome;
  }, { timeout: fixtureTimeout });
  return result;
}

function definition(id: string, url: string): AcpBackendDefinitionV1 {
  return AcpBackendDefinitionV1Schema.parse({ id, name: id, title: `Agent ${id}`, createdAt: 1, updatedAt: 1,
    launch: { kind: 'archive', version: '1.2.3', assetsByPlatform: {
      [`${process.platform}-${process.arch}`]: { archiveUrl: url, kind: 'executable', executableSubpath: 'agent' },
    } } });
}

describe('definition-qualified managed Agent jobs', () => {
  it('refuses a reviewed pin that no longer matches the captured Account definition before admitting a job', async () => {
    const current = AcpBackendDefinitionV1Schema.parse({ id: 'reviewed-agent', name: 'reviewed-agent', title: 'Reviewed Agent',
      launch: { kind: 'npm', package: '@fixture/reviewed-agent', version: '2.0.0' }, createdAt: 1, updatedAt: 2 });
    const owner = createAgentInstallJobOwner({ accountId: 'alice', readTrackedSessions: () => [],
      readRegistry: () => ({ agents: [{ id: 'custom-acp', pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId,
        identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 }] }),
      readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions: [current] }, revision: 2 }) });
    try {
      const request = { agentId: 'custom-acp', definitionId: current.id, expectedDefinitionVersion: '1.0.0',
        intent: 'install', consent: { vendorRecipe: false } } as const;
      const rejected = owner.start(request);
      expect(rejected).toMatchObject({ ok: false, errorCode: 'definition_version_changed' });
      expect(DaemonAgentInstallStartResponseSchema.parse(rejected)).toEqual(rejected);
      expect(owner.list()).toEqual({ ok: true, jobs: [] });
      // An ordinary request may still install current, but a reviewed stale pin
      // must neither create another job nor join that newly admitted version.
      const active = owner.start({ agentId: 'custom-acp', definitionId: current.id,
        intent: 'install', consent: { vendorRecipe: false } });
      expect(active.ok).toBe(true);
      const before = owner.list();
      expect(owner.start(request)).toMatchObject({ ok: false, errorCode: 'definition_version_changed' });
      expect(owner.list()).toEqual(before);
    } finally { await owner.shutdown(); }
  });
  it('installs pinned npm definitions and records removable identity in the host workspace manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-definition-npm-job-'));
    const sessions: TrackedSession[] = [{ pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: root,
      agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'npm-agent' } } }];
    let owner: AgentInstallJobOwner | undefined;
    const publications: DaemonState[] = [];
    const invalidation = createDaemonPluginRegistryProjectionInvalidation({
      getApiMachine: () => ({ updateDaemonState: async updater => {
        publications.push(updater(publications.at(-1) ?? null));
      } }),
      isDaemonQuiescing: () => false,
      onPublicationFailure: error => { throw error; },
    });
    try {
      const pnpm = join(root, 'pnpm'); await writeFile(pnpm, '#!/bin/sh\nexit 0\n'); await chmod(pnpm, 0o755);
      const env = { ...process.env, HAPPIER_HOME_DIR: root, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath };
      const definition = AcpBackendDefinitionV1Schema.parse({ id: 'npm-agent', name: 'npm-agent', title: 'Npm Agent',
        launch: { kind: 'npm', package: '@fixture/agent', version: '1.2.3' }, createdAt: 1, updatedAt: 1 });
      owner = createAgentInstallJobOwner({ accountId: 'alice', env, invalidateInventory: invalidation.invalidateProjection,
        readTrackedSessions: () => sessions, readRegistry: () => ({ agents: [{
        id: 'custom-acp', pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      }] }), readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions: [definition] }, revision: 1 }),
      installerDeps: { execFileWithDeadline: async (_command, args) => {
        // Only package-manager process output is substituted; staging, selection, metadata and promotion stay real.
        const workspace = args[1]!;
        const packageRoot = join(workspace, 'node_modules', '@fixture', 'agent'); await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/agent', version: args[3]!.split('@').at(-1), bin: { cli: 'cli.js' } }));
        const bin = join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'cli.cmd' : 'cli');
        await mkdir(dirname(bin), { recursive: true }); await writeFile(bin, '#!/bin/sh\nexit 0\n'); await chmod(bin, 0o755);
        return { stdout: '', stderr: '' };
      } } });
      const job = owner.start({ agentId: 'custom-acp', definitionId: definition.id, expectedDefinitionVersion: '1.2.3',
        intent: 'install', consent: { vendorRecipe: false } });
      expect(job.ok).toBe(true); if (!job.ok) return;
      expect(await terminal(owner, job.jobId)).toEqual({ kind: 'succeeded', version: '1.2.3' });
      expect(publications.map(state => state.contributionRegistryProjectionRevision)).toEqual([1]);
      const ready = await resolveAcpLaunch({ accountId: 'alice', definition, env, platform: process.platform, arch: process.arch });
      expect(ready.kind).toBe('ready'); if (ready.kind !== 'ready') return;
      expect(JSON.parse(await readFile(join(dirname(dirname(ready.command)), 'workspace', 'package.json'), 'utf8')))
        .toMatchObject({ happierManagedAcp: { definitionId: definition.id, title: definition.title, kind: 'npm', version: '1.2.3' } });
      if (definition.launch.kind !== 'npm') throw new Error('Expected npm fixture');
      definition.launch.version = '2.0.0';
      const replacement = owner.start({ agentId: 'custom-acp', definitionId: definition.id, intent: 'update', consent: { vendorRecipe: false } });
      expect(replacement.ok).toBe(true); if (!replacement.ok) return;
      expect(await terminal(owner, replacement.jobId)).toMatchObject({ kind: 'succeeded', version: '2.0.0' });
      expect(publications.map(state => state.contributionRegistryProjectionRevision)).toEqual([1, 2]);
      await expect(access(ready.command)).resolves.toBeUndefined();
      definition.launch.version = '1.2.3';
      expect(await resolveAcpLaunch({ accountId: 'alice', definition, env, platform: process.platform, arch: process.arch })).toMatchObject({ kind: 'ready' });
      sessions.length = 0;
      const uninstall = owner.start({ agentId: 'custom-acp', definitionId: definition.id, intent: 'uninstall', consent: { vendorRecipe: false } });
      expect(uninstall.ok).toBe(true); if (!uninstall.ok) return;
      expect(await terminal(owner, uninstall.jobId)).toEqual({ kind: 'succeeded', version: null });
      expect(publications.map(state => state.contributionRegistryProjectionRevision)).toEqual([1, 2, 3]);
      await expect(access(ready.command)).rejects.toThrow();
    } finally { await owner?.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps definitions distinct, streams download bytes, proves ready, and removes only its managed install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-definition-job-'));
    const responses: ServerResponse[] = [];
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
    const sessions: TrackedSession[] = [];
    const server = createServer((_req, response) => {
      responses.push(response); response.writeHead(200, { 'content-length': bytes.length });
      if (responses.length > 2) response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    let owner: AgentInstallJobOwner | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP address');
      transport.origin = `http://127.0.0.1:${address.port}`;
      const env = { HAPPIER_HOME_DIR: root, PATH: root };
      const definitions = ['alpha', 'beta'].map(id => definition(id, `https://definition-job-fixture.invalid/${id}`));
      owner = createAgentInstallJobOwner({ accountId: 'alice', env, readRegistry: () => ({ agents: [{ id: 'custom-acp',
        pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 }] }),
        readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions }, revision: 1 }),
        readTrackedSessions: () => sessions });
      const jobs = definitions.map(entry => owner!.start({ agentId: 'custom-acp', definitionId: entry.id,
        intent: 'install', consent: { vendorRecipe: false } }));
      expect(jobs.every(job => job.ok)).toBe(true);
      if (!jobs[0]!.ok || !jobs[1]!.ok) return;
      expect(jobs[0]!.jobId).not.toBe(jobs[1]!.jobId);
      await vi.waitFor(() => expect(responses).toHaveLength(2), { timeout: fixtureTimeout });
      for (const response of responses) response.end(bytes);
      for (const [index, job] of jobs.entries()) {
        if (!job.ok) throw new Error('Job was not admitted');
        expect(await terminal(owner, job.jobId)).toEqual({ kind: 'succeeded', version: '1.2.3', checksum: 'not_published' });
        expect(owner.read({ jobId: job.jobId, cursor: 0 })).toMatchObject({ progress: [expect.objectContaining({ bytesDone: bytes.length, bytesTotal: bytes.length })] });
        expect(await resolveAcpLaunch({ accountId: 'alice', definition: definitions[index]!, platform: process.platform, arch: process.arch, env })).toMatchObject({ kind: 'ready' });
      }
      const foreign = owner.start({ agentId: 'custom-acp', definitionId: 'alpha', intent: 'install', consent: { vendorRecipe: false } },
        { accountId: 'bob', catalog: { status: 'ready', record: { v: 1, definitions }, revision: 1 } });
      expect(foreign.ok).toBe(true); if (!foreign.ok) return;
      expect(await terminal(owner, foreign.jobId, 'bob')).toMatchObject({ kind: 'succeeded' });
      const ownLaunch = await resolveAcpLaunch({ accountId: 'alice', definition: definitions[0]!, platform: process.platform, arch: process.arch, env });
      const foreignLaunch = await resolveAcpLaunch({ accountId: 'bob', definition: definitions[0]!, platform: process.platform, arch: process.arch, env });
      expect(ownLaunch.kind).toBe('ready'); expect(foreignLaunch.kind).toBe('ready');
      if (ownLaunch.kind === 'ready' && foreignLaunch.kind === 'ready') expect(foreignLaunch.command).not.toBe(ownLaunch.command);
      const listed = owner.list('alice');
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error(listed.error);
      expect(listed.jobs.some(job => job.jobId === foreign.jobId)).toBe(false);
      expect(owner.read({ jobId: foreign.jobId, cursor: 0 }, 'alice')).toMatchObject({ ok: false, errorCode: 'job_not_found' });
      expect(await owner.cancel({ jobId: foreign.jobId }, 'alice')).toMatchObject({ ok: false, errorCode: 'job_not_found' });
      sessions.push({ pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: root,
        agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'beta' } } });
      if (definitions[1]!.launch.kind !== 'archive') throw new Error('Expected archive fixture');
      definitions[1]!.launch.version = '2.0.0';
      const replacement = owner.start({ agentId: 'custom-acp', definitionId: 'beta', intent: 'install', consent: { vendorRecipe: false } });
      expect(replacement.ok).toBe(true); if (!replacement.ok) return;
      expect(await terminal(owner, replacement.jobId)).toMatchObject({ kind: 'succeeded', version: '2.0.0' });
      definitions[1]!.launch.version = '1.2.3';
      const uninstall = owner.start({ agentId: 'custom-acp', definitionId: 'alpha', intent: 'uninstall', consent: { vendorRecipe: false } });
      expect(uninstall.ok).toBe(true);
      if (!uninstall.ok) return;
      expect(await terminal(owner, uninstall.jobId)).toMatchObject({ kind: 'succeeded' });
      expect(await resolveAcpLaunch({ accountId: 'alice', definition: definitions[0]!, platform: process.platform, arch: process.arch, env })).toMatchObject({ kind: 'needs_install' });
      expect(await resolveAcpLaunch({ accountId: 'bob', definition: definitions[0]!, platform: process.platform, arch: process.arch, env })).toMatchObject({ kind: 'ready' });
      expect(await resolveAcpLaunch({ accountId: 'alice', definition: definitions[1]!, platform: process.platform, arch: process.arch, env })).toMatchObject({ kind: 'ready' });
      await writeFile(join(root, 'agent'), bytes); await chmod(join(root, 'agent'), 0o755);
      const systemOnly = owner.start({ agentId: 'custom-acp', definitionId: 'alpha', intent: 'uninstall', consent: { vendorRecipe: false } });
      if (!systemOnly.ok) expect(systemOnly.errorCode).toBe('not_managed');
      else expect(await terminal(owner, systemOnly.jobId)).toMatchObject({ kind: 'failed', code: 'not_managed' });
      await access(join(root, 'agent'));
    } finally {
      await owner?.shutdown(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['linux', 'darwin', 'win32'] as const)('refuses live definition uninstall and forced reinstall on %s', async platform => {
    const definitions = [definition('busy', 'https://definition-job-fixture.invalid/unused')];
    const sessions: TrackedSession[] = [{ pid: process.pid, startedBy: 'daemon', spawnOptions: {
      directory: tmpdir(), agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'busy' },
    } }];
    const owner = createAgentInstallJobOwner({ accountId: 'alice', platform, readRegistry: () => ({ agents: [{ id: 'custom-acp',
      pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 }] }),
      readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions }, revision: 1 }), readTrackedSessions: () => sessions });
    try {
      for (const input of [{ intent: 'uninstall' as const }, { intent: 'install' as const, force: true }]) {
        expect(owner.start({ agentId: 'custom-acp', definitionId: 'busy', consent: { vendorRecipe: false }, ...input }))
          .toMatchObject({ ok: false, errorCode: 'in_use' });
      }
      expect(owner.list()).toEqual({ ok: true, jobs: [] });
    } finally { await owner.shutdown(); }
  });
});
