import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault,
  inspectUsableSourceDevSharedDepsLastGreen as inspectUsableSourceDevSharedDepsLastGreenDefault,
  syncSharedDepsForSourceDev as syncSharedDepsForSourceDevDefault,
} from '../../stack/scripts/utils/proc/pm.mjs';
import {
  findReactNativeEnrichedMarkdownPackageDirs,
  formatReactNativeEnrichedMarkdownWebStreamingPatchFailure,
  verifyReactNativeEnrichedMarkdownWebStreamingPatch,
} from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));

export async function hasUsableUiWorkspaceLastGreen({
  uiPackageDir = uiDir,
  inspectUsableSourceDevSharedDepsLastGreen = inspectUsableSourceDevSharedDepsLastGreenDefault,
} = {}) {
  const inspection = await inspectUsableSourceDevSharedDepsLastGreen(
    resolve(uiPackageDir, '../..'),
    { workspaceNames: ['plugin-sdk'] },
  );
  return inspection?.usable === true;
}

export function verifyUiPatchedDependencies({ uiPackageDir = uiDir } = {}) {
  const packageDirs = findReactNativeEnrichedMarkdownPackageDirs({
    repoRootDir: resolve(uiPackageDir, '../..'),
    expoAppDir: uiPackageDir,
  });
  if (packageDirs.length === 0) {
    throw new Error(
      '[ui] react-native-enriched-markdown is not installed. Run the canonical UI dependency preparation: '
      + 'yarn --cwd apps/ui postinstall:real',
    );
  }

  const failures = packageDirs.flatMap((packageDir) => {
    const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir });
    return result.status === 'ok'
      ? []
      : [`${packageDir}\n${formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result)}`];
  });
  if (failures.length > 0) {
    throw new Error(`[ui] patched dependency preflight failed:\n${failures.join('\n\n')}`);
  }
}

function readRebuiltBundledPluginWorkspaceNames(result) {
  const out = [];
  const seen = new Set();
  for (const rawPackageName of Array.isArray(result?.built) ? result.built : []) {
    if (typeof rawPackageName !== 'string') continue;
    const workspaceName = rawPackageName.trim().replace(/^@happier-dev\//, '');
    if (!workspaceName.startsWith('plugins-') || seen.has(workspaceName)) continue;
    seen.add(workspaceName);
    out.push(workspaceName);
  }
  return out;
}

export async function ensureUiWorkspacePackagesBuilt({
  env = process.env,
  uiPackageDir = uiDir,
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
  syncSharedDepsForSourceDev = syncSharedDepsForSourceDevDefault,
  verifyPatchedDependencies = verifyUiPatchedDependencies,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  verifyPatchedDependencies({ uiPackageDir });
  const result = await ensureWorkspacePackagesBuiltForComponent(uiPackageDir, { quiet: false, env });
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  if (skipped.includes('not-monorepo')) {
    throw new Error('[ui] ensure:workspace:built failed (not-monorepo): apps/ui must be run from inside the Happier monorepo checkout.');
  }
  const rebuiltPluginWorkspaceNames = readRebuiltBundledPluginWorkspaceNames(result);
  if (rebuiltPluginWorkspaceNames.length > 0) {
    // Expo adoption happens after this preflight returns. Feed the canonical
    // publisher only E2's actual rebuilt plugin set so it validates and
    // publishes one matching registry/artifact pair before Expo can resolve
    // those new package bytes.
    await syncSharedDepsForSourceDev(repoRoot, {
      env,
      includeRuntimeDependencies: true,
      quiet: false,
      workspaceNames: rebuiltPluginWorkspaceNames,
      ...(String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1'
        ? {
            // A dev target owns its ignored `dist` trees. Rebuilds are deterministic,
            // but the app's static asset projection must describe the bytes present on
            // this replica rather than a prior local build. The canonical generator's
            // aggregate path reads those final artifacts without restaging plugins.
            bundledPluginArtifactPublication: {
              mode: 'write',
              aggregateOnly: true,
            },
          }
        : {}),
    });
  }
  return result;
}

async function run() {
  await ensureUiWorkspacePackagesBuilt();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
