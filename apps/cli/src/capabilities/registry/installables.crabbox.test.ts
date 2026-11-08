import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CRABBOX_PLUGIN } from '../../../../../packages/plugins/machine-crabbox/src/manifest';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';
import { createV2ManagedDependencySourceModel } from '@/plugins/runtime/invocation/services/managedDependencySourceModel';
import { createStablePluginManagedDependenciesHost } from '@/plugins/runtime/invocation/services/managedDependencies';
import { createProductionManagedDependencySourceAdapter } from '@/plugins/runtime/invocation/services/managedDependencySourceAdapters';
import { createInstallableCapabilitiesFromContributions } from './installables';
import { createCapabilitiesService } from '../service';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/managedDependencies';
import { CHECKLIST_IDS } from '../checklistIds';

const roots: string[] = [];
const environment = createEnvKeyScope(['PATH', 'HAPPIER_HOME_DIR']);
afterEach(async () => {
  environment.restore(); reloadConfiguration();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function writeSystemExecutable(root: string) {
  // The OS executable is the boundary. Record version probes without creating
  // a native lease, downloading a package or performing a managed installation.
  const executable = join(root, process.platform === 'win32' ? 'crabbox.cmd' : 'crabbox');
  await writeFile(join(root, 'version-probes.log'), '');
  await writeFile(executable, process.platform === 'win32'
    ? '@echo off\r\necho version>>"%~dp0version-probes.log"\r\necho crabbox 0.72.0\r\n'
    : '#!/bin/sh\nprintf "version\\n" >> "${0%/*}/version-probes.log"\nprintf "crabbox 0.72.0\\n"\n');
  await chmod(executable, 0o755);
}

describe('Crabbox prerequisite capabilities', () => {
  it('exposes the real dependency state and executable presence, including a system installation without a managed archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crabbox-capability-'));
    roots.push(root);
    const declaration = CRABBOX_PLUGIN.manifest.contributes.managedDependencies?.find(entry => entry.id === 'crabbox-cli');
    if (!declaration) throw new Error('Crabbox dependency declaration missing');
    const contribution: ResolvedInstallableContribution = { provenance: 'first_party', source: { kind: 'bundled' },
      pluginId: CRABBOX_PLUGIN.manifest.id, manifestPath: '/bundled/crabbox/plugin.json', daemonEntryPath: null,
      sourceSpec: { kind: 'bundled', locator: '@happier-dev/plugins-machine-crabbox', trustPolicy: 'local_trusted', installPolicy: 'copy' },
      definition: PluginManagedDependencyContributionV2Schema.parse(declaration) };
    const contributions = [contribution];
    const env = { ...process.env, PATH: root, HAPPIER_HOME_DIR: root };
    let current = true;
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const host = createStablePluginManagedDependenciesHost({
      installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributions),
      sourceModel: createV2ManagedDependencySourceModel({ platform, architecture: process.arch, contributions }),
      getSettings: () => ({}), env, isCurrent: () => current,
      resolveAdapter: async () => { throw new Error('V2 must use its source owner'); },
      resolveSourceAdapter: input => createProductionManagedDependencySourceAdapter({ ...input, env }),
      removeManagedInstall: async () => {},
    });
    const capabilities = await createInstallableCapabilitiesFromContributions({ installables: contributions,
      readManagedDependencyStatus: dependency => host.bind(dependency.pluginId).status(dependency.localId) });
    const service = createCapabilitiesService({ capabilities, checklists: { [CHECKLIST_IDS.MACHINE_DETAILS]: [], [CHECKLIST_IDS.NEW_SESSION]: [] }, buildContext: async () => ({ cliSnapshot: null }) });
    expect(service.describe().capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'dep.crabbox' })]));
    const read = async () => (await service.detect({ requests: [{ id: 'dep.crabbox' }] })).results['dep.crabbox'];
    expect(await read()).toMatchObject({ ok: true, data: { state: 'missing', executablePresent: false, installed: false } });
    await writeSystemExecutable(root);
    expect(await read()).toMatchObject({ ok: true, data: { state: 'ready', executablePresent: true, installed: true, version: '0.72.0' } });
    expect(await host.bind(CRABBOX_PLUGIN.manifest.id).ensure('crabbox-cli')).toMatchObject({ state: 'ready' });
    current = false;
    expect(await read()).toMatchObject({ ok: true, data: { state: 'unsupported', executablePresent: null } });
  });

  it('reads the system-ready source through the public standalone capability service without a daemon runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crabbox-standalone-'));
    roots.push(root);
    await writeSystemExecutable(root);
    environment.patch({ HAPPIER_HOME_DIR: root, PATH: root });
    reloadConfiguration();
    const { createCliCapabilitiesService } = await import('@/rpc/handlers/capabilities');
    const service = await createCliCapabilitiesService();
    const census = service.describe().capabilities;
    expect(census).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'dep.crabbox' })]));
    expect(await readFile(join(root, 'version-probes.log'), 'utf8')).toBe('');
    expect(await service.detect({ requests: [{ id: 'dep.crabbox' }] })).toMatchObject({
      results: { 'dep.crabbox': { ok: true, data: { state: 'ready', executablePresent: true, installed: true, version: '0.72.0' } } },
    });
    expect((await readFile(join(root, 'version-probes.log'), 'utf8')).trim().split(/\r?\n/u)).toEqual(['version']);
    console.info(`[capability-cost] census=${census.length} describeCrabboxVersionProbes=0 selectedCrabboxDetectVersionProbes=1`);
  });
});
