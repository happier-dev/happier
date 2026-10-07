import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Both stage-zero/source-test installs and full PM preparation consume this
// owner. It must load before cli-common or other workspace dist exists.
export async function ensureUiPostinstallOutputs(componentDir, installDir, {
  quiet = false,
  force = false,
  runPostinstall,
  restoreDependencies,
} = {}) {
  const manifestPath = join(componentDir, 'package.json');
  if (!existsSync(manifestPath)) return;
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (pkg?.name !== '@happier-dev/app' || typeof pkg?.scripts?.['postinstall:real'] !== 'string') return;

  const inspectReadiness = async () => {
    const verifierPath = join(componentDir, 'tools', 'postinstall', 'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs');
    if (existsSync(verifierPath)) {
      const { verifyUiPatchedDependencies } = await import(pathToFileURL(verifierPath).href);
      try {
        verifyUiPatchedDependencies({ uiPackageDir: componentDir });
        return [];
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    }
    // Installed/non-checkout contexts may not carry the source verifier.
    const packageDirs = [...new Set([
      join(componentDir, 'node_modules', 'react-native-enriched-markdown'),
      join(installDir, 'node_modules', 'react-native-enriched-markdown'),
    ])].filter(dir => existsSync(dir));
    if (packageDirs.length === 0) packageDirs.push(join(componentDir, 'node_modules', 'react-native-enriched-markdown'));
    return packageDirs.map(dir => join(dir, 'lib', 'module', 'web', 'streamingReveal.js')).filter(file => !existsSync(file));
  };
  if (!force && (await inspectReadiness()).length === 0) return;
  if (!quiet) console.log('[local] repairing happier-ui postinstall outputs...');
  try {
    await runPostinstall();
  } catch {
    // Changed patch inputs can leave a mixed tree. Re-extract pristine bytes
    // through the caller's PM adapter, then retry the same UI postinstall.
    if (!quiet) console.log('[local] repairing mixed happier-ui patched dependency bytes...');
    await restoreDependencies();
    await runPostinstall();
  }
  const failures = await inspectReadiness();
  if (failures.length > 0) {
    throw new Error(`[local] happier-ui postinstall completed without satisfying patched dependency readiness:\n${failures.map(failure => `- ${failure}`).join('\n')}`);
  }
}
