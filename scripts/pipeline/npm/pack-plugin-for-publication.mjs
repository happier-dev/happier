// Runs under the selected checkout's existing CLI source-runtime loader.
import { parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function packPluginForPublication({ repoRoot, pluginRoot, version, tarball, happyHomeDir }) {
  const home = happyHomeDir ?? await mkdtemp(join(tmpdir(), 'happier-plugin-publication-host-'));
  const previousHome = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = home;
  let reloadController;
  let prepared;
  try {
    const { packLocalPlugin } = await import(pathToFileURL(join(repoRoot, 'apps/cli/src/plugins/packaging/pack.ts')).href);
    const { createDaemonArchivePluginChangePreparer } = await import(pathToFileURL(join(repoRoot, 'apps/cli/src/plugins/daemon/archiveChangePreparer.ts')).href);
    const { createPluginRegistryStateStore } = await import(pathToFileURL(join(repoRoot, 'apps/cli/src/plugins/store/registry/currentState.ts')).href);
    const { createPluginReloadController } = await import(pathToFileURL(join(repoRoot, 'apps/cli/src/plugins/runtime/reload/controller.ts')).href);
    const { createDaemonPluginRegistryRuntimeLifecycle } = await import(pathToFileURL(join(repoRoot, 'apps/cli/src/plugins/runtime/reload/registryRuntimeLifecycle.ts')).href);
    const packed = await packLocalPlugin({ locator: pluginRoot, outPath: tarball, publication: { version } });
    if (!packed.ok) throw new Error(`Plugin pack rejected: ${packed.diagnostics.map(value => `${value.code}: ${value.message}`).join('; ')}`);
    reloadController = createPluginReloadController({ happyHomeDir: home });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir: home, reloadController });
    await createPluginRegistryStateStore({ happyHomeDir: home, runtimeLifecycle }).initialize();
    const prepare = createDaemonArchivePluginChangePreparer({ happyHomeDir: home, runtimeLifecycle });
    prepared = await prepare({ kind: 'installArchive', locator: packed.archivePath });
    const installed = await prepared.apply({ optionalSelections: [] });
    if (installed.kind !== 'committed') throw new Error(`Plugin temporary-host install rejected (${installed.kind}): ${installed.code ?? installed.message ?? ''}`);
    return packed;
  } finally {
    if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHome;
    try { await reloadController?.shutdown(); }
    finally {
      try { await prepared?.cleanup(); }
      finally { if (!happyHomeDir) await rm(home, { recursive: true, force: true }); }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'repo-root': { type: 'string' }, 'plugin-root': { type: 'string' }, version: { type: 'string' }, tarball: { type: 'string' } } });
  await packPluginForPublication({ repoRoot: values['repo-root'], pluginRoot: values['plugin-root'], version: values.version, tarball: values.tarball });
}
