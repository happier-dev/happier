import { mkdtemp, readFile, rm, access, writeFile, chmod } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { buildMemberAgentInstallEnvironment } from './memberInstallEnvironment';
import { runMemberAgentInstallEffect } from './memberInstallEffect';
import { selectExecutableManagedDependencies } from '@/plugins/projection/registry/managedDependencyExecutables';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

const transport = vi.hoisted(() => ({ origin: '' }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  const http = await import('node:http');
  return { ...actual, request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) =>
    url.hostname === 'member-dependency-fixture.invalid'
      ? http.request(new URL(url.pathname, transport.origin), options, callback) : actual.request(url, options, callback) };
});

afterEach(() => { vi.unstubAllEnvs(); });

function vendorSpec(script: string): AgentCliRuntimeDescriptor {
  return { id: 'fixture-member', title: 'Member Agent', binaryName: 'fixture-member',
    knownUserBinDirSuffixes: ['.local/bin'], sourcePreferenceDefault: 'system-first',
    managedInstall: null, manualInstallKind: 'vendor_recipe', acceptsJavaScriptFileOverride: false,
    manualInstallRecipes: { linux: [{ cmd: '/bin/sh', args: ['-c', script] }] } };
}

test.skipIf(process.platform !== 'linux')('whole member installer writes and verifies the vendor executable in its native home without owner configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-member-install-'));
  const owner = await mkdtemp(join(tmpdir(), 'happier-owner-install-'));
  const input = new PassThrough(); const output = new PassThrough();
  let records = ''; output.on('data', chunk => { records += String(chunk); if (String(chunk).includes('"t":"outcome"')) input.end(); });
  vi.stubEnv('HOME', owner); vi.stubEnv('HAPPIER_HOME_DIR', owner);
  vi.stubEnv('NPM_CONFIG_USERCONFIG', join(owner, '.npmrc')); vi.stubEnv('PIP_CONFIG_FILE', join(owner, 'pip.conf'));
  vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', join(owner, 'tools')); vi.stubEnv('GITHUB_TOKEN', 'owner-secret');
  try {
    const spec = vendorSpec('mkdir -p "$HOME/.local/bin"; printf "#!/usr/bin/env bash\\nprintf \'fixture-member 1.2.3\\\\n\'\\n" > "$HOME/.local/bin/fixture-member"; chmod 755 "$HOME/.local/bin/fixture-member"; env > "$HOME/installer-environment"');
    input.write(`${JSON.stringify({ kind: 'install', request: { agentId: spec.id, intent: 'install', consent: { vendorRecipe: true } },
      accountId: 'member', registry: { agents: [{ id: spec.id, runtimeSpec: spec }] }, targetInUse: false, runtimeManagedDependencyId: null })}\n`);
    await runMemberAgentInstallEffect(input, output, new AbortController().signal, buildMemberAgentInstallEnvironment(home));
    expect(records.split('\n').filter(Boolean).map(line => JSON.parse(line))).toContainEqual({ t: 'outcome', outcome: { kind: 'succeeded', version: '1.2.3' } });
    const environment = await readFile(join(home, 'installer-environment'), 'utf8');
    expect(environment).toContain(`HOME=${home}`);
    expect(environment).not.toContain(owner); expect(environment).not.toContain('owner-secret');
    await expect(access(join(owner, '.local/bin/fixture-member'))).rejects.toThrow();
  } finally { input.destroy(); output.destroy(); await rm(home, { recursive: true, force: true }); await rm(owner, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'linux')('private cancellation waits for the vendor process to stop and returns a cancelled outcome', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-member-cancel-'));
  const input = new PassThrough(); const output = new PassThrough();
  let records = ''; output.on('data', chunk => { records += String(chunk); if (String(chunk).includes('"t":"outcome"')) input.end(); });
  const spec = vendorSpec('printf started > "$HOME/started"; /bin/sleep 100');
  input.write(`${JSON.stringify({ kind: 'install', request: { agentId: spec.id, intent: 'install', consent: { vendorRecipe: true } },
    accountId: 'member', registry: { agents: [{ id: spec.id, runtimeSpec: spec }] }, targetInUse: false, runtimeManagedDependencyId: null })}\n`);
  const run = runMemberAgentInstallEffect(input, output, new AbortController().signal, buildMemberAgentInstallEnvironment(home));
  try {
    await vi.waitFor(() => access(join(home, 'started')));
    input.write('cancel\n');
    await run;
    expect(records.split('\n').filter(Boolean).map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      t: 'outcome', outcome: expect.objectContaining({ kind: 'failed', code: 'cancelled' }),
    }));
  } finally { input.end(); await run; output.destroy(); await rm(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'linux')('native installer consumes the admitted canonical dependency descriptor without owner manifest paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-member-dependency-'));
  const input = new PassThrough(); const output = new PassThrough();
  let records = ''; output.on('data', chunk => { records += String(chunk); if (String(chunk).includes('"t":"outcome"')) input.end(); });
  const dependencyBytes = '#!/bin/sh\nprintf "companion 2.0.0\\n"\n';
  await writeFile(join(home, 'companion'), dependencyBytes); await chmod(join(home, 'companion'), 0o755);
  await createTar({ gzip: true, cwd: home, file: join(home, 'companion.tar.gz') }, ['companion']);
  const archive = await readFile(join(home, 'companion.tar.gz'));
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-length': archive.length }); response.end(archive); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing dependency fixture address');
    transport.origin = `http://127.0.0.1:${address.port}`;
    const declaration = { provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.plugin', manifestPath: '/owner-private/plugin.json',
      definition: { id: 'companion-local', title: 'Fixture companion', executable: 'companion', sources: [{
        kind: 'pinnedArchive', installId: 'dep.fixture.companion', version: '2.0.0', assetsByPlatform: { [`linux-${process.arch}`]: {
          archiveUrl: 'https://member-dependency-fixture.invalid/companion.tar.gz', sha256: createHash('sha256').update(archive).digest('hex'), executableSubpath: 'companion',
        } },
      }] } } satisfies ResolvedInstallableContribution;
    const dependencies = selectExecutableManagedDependencies([declaration]).map(({ definition, pluginId, provenance, source }) => ({ definition, pluginId, provenance, source }));
    expect(dependencies).toHaveLength(1);
    const spec = vendorSpec('mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\nprintf \'fixture-member 1.2.3\\\\n\'\\n" > "$HOME/.local/bin/fixture-member"; chmod 755 "$HOME/.local/bin/fixture-member"');
    input.write(`${JSON.stringify({ kind: 'install', request: { agentId: spec.id, intent: 'install', consent: { vendorRecipe: true } },
      accountId: 'member', registry: { agents: [{ id: spec.id, runtimeSpec: spec }], managedDependencies: dependencies },
      targetInUse: false, runtimeManagedDependencyId: 'fixture.plugin/companion-local' })}\n`);
    await runMemberAgentInstallEffect(input, output, new AbortController().signal, buildMemberAgentInstallEnvironment(home));
    expect(records.split('\n').filter(Boolean).map(line => JSON.parse(line))).toContainEqual({ t: 'outcome', outcome: { kind: 'succeeded', version: '1.2.3' } });
    expect(await readFile(join(home, '.happier/tools/dep.fixture.companion/current/companion'), 'utf8')).toBe(dependencyBytes);
    expect(records).not.toContain('owner-private');
  } finally { input.destroy(); output.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
