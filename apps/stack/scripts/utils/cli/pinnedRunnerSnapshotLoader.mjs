import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function pinnedRunnerSnapshotModuleOwnsDefault(module) {
  return typeof module?.resolveNewestReadyPinnedRunnerSnapshot === 'function'
    && typeof module?.listReadyPinnedRunnerSnapshots === 'function'
    && typeof module?.isPinnedRunnerSnapshotReady === 'function';
}

export async function loadPinnedRunnerSnapshotModule(options = {}) {
  const importPackageModule = options.importPackageModule
    ?? (() => import('@happier-dev/cli-common/pinnedRunnerSnapshot'));
  const existsSyncImpl = options.existsSyncImpl ?? existsSync;
  const importModule = options.importModule ?? ((moduleUrl) => import(moduleUrl));
  let packageModule = null;
  try {
    packageModule = await importPackageModule();
    if (pinnedRunnerSnapshotModuleOwnsDefault(packageModule)) {
      return packageModule;
    }
  } catch (packageImportError) {
    packageModule = { packageImportError };
  }

  // A source Stack can run before its mounted workspace package copy has received a newly-added
  // export. Packed Stack installs never have this source path, so they must use the bundled
  // package export above rather than accidentally reaching into the repository layout.
  const sourceModulePath = options.sourceModulePath ?? resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/cli-common/pinnedRunnerSnapshot.mjs',
  );
  if (!existsSyncImpl(sourceModulePath)) {
    if (packageModule?.packageImportError) throw packageModule.packageImportError;
    throw new Error('Pinned runner snapshot module is missing its canonical ready selector');
  }
  const sourceModule = await importModule(pathToFileURL(sourceModulePath).href);
  if (!pinnedRunnerSnapshotModuleOwnsDefault(sourceModule)) {
    throw new Error('Canonical pinned runner snapshot source is missing its ready selector');
  }
  return sourceModule;
}

const { resolveNewestReadyPinnedRunnerSnapshot } = await loadPinnedRunnerSnapshotModule();

export { resolveNewestReadyPinnedRunnerSnapshot };
