import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { dependencyInstallationFailure, isDependencyRefreshDisabled, markDependencyMutation, removeInstalledDependencyQuarantine, waitForDependencyRefreshWriter, withDependencyRefreshLock } from './dependency_refresh.mjs';

function resolveUiPostinstallMarkerPath(installDir) {
  return join(installDir, 'node_modules', '.happier-ui-postinstall-ready');
}

async function uiInputDigest(componentDir, input) {
  const hash = createHash('sha256');
  const visit = async path => {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) return;
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    hash.update(relative(componentDir, path).split(sep).join('/'));
    if (!info) hash.update('\0missing\0');
    else if (info.isFile()) hash.update('\0file\0').update(await readFile(path));
    else if (info.isSymbolicLink()) hash.update('\0link\0').update(await readlink(path));
    else if (info.isDirectory()) {
      hash.update('\0directory\0');
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
  };
  await visit(resolve(componentDir, input));
  return hash.digest('hex');
}

async function inspectUiPostinstallFreshness(componentDir, installDir, pkg, env) {
  const inputs = pkg?.happier?.installFreshnessInputs;
  const tasksPath = join(componentDir, 'tools', 'resolveUiPostinstallTasks.mjs');
  if (inputs == null || !existsSync(tasksPath)) return null;
  if (!Array.isArray(inputs) || inputs.some(input => typeof input !== 'string' || !input.trim())) {
    throw new Error(`Invalid happier.installFreshnessInputs in ${join(componentDir, 'package.json')}`);
  }
  for (const input of inputs) {
    const outside = relative(componentDir, resolve(componentDir, input));
    if (isAbsolute(input) || outside === '..' || outside.startsWith(`..${sep}`)) {
      throw new Error('UI postinstall freshness inputs must stay inside the UI package');
    }
  }
  const { resolveUiPostinstallTasks, resolveUiPostinstallTaskInputs } = await import(pathToFileURL(tasksPath).href);
  // A previous selected invocation must not narrow the freshness inventory.
  const taskEnv = { ...env,
    HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: env.HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY ?? '1' };
  delete taskEnv.HAPPIER_UI_POSTINSTALL_TASKS;
  const tasks = resolveUiPostinstallTasks({ env: taskEnv });
  const taskInputs = resolveUiPostinstallTaskInputs({ tasks, installFreshnessInputs: inputs });
  const inputDigests = new Map(await Promise.all([...new Set(Object.values(taskInputs).flat())]
    .map(async input => [input, await uiInputDigest(componentDir, input)])));
  const fingerprints = Object.fromEntries(tasks.map(task => [task, createHash('sha256')
    .update(JSON.stringify(taskInputs[task].map(input => [input, inputDigests.get(input)]))).digest('hex')]));
  const markerPath = resolveUiPostinstallMarkerPath(installDir);
  const marker = await readJsonIfExists(markerPath).catch(() => null);
  const stale = tasks.filter(task => marker?.version !== 1 || marker?.tasks?.[task] !== fingerprints[task]);
  return { markerPath, fingerprints, stale };
}

async function inspectUiPostinstallState(componentDir, installDir, { env = process.env, checkFreshness = true } = {}) {
  const manifestPath = join(componentDir, 'package.json');
  if (!existsSync(manifestPath)) return { failures: [], freshness: null };
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (pkg?.name !== '@happier-dev/app' || typeof pkg?.scripts?.['postinstall:real'] !== 'string') return { failures: [], freshness: null };
  const freshness = checkFreshness ? await inspectUiPostinstallFreshness(componentDir, installDir, pkg, env) : null;
  const staleFailures = freshness?.stale.map(task => `Stale UI postinstall task: ${task}`) ?? [];

  const verifierPath = join(componentDir, 'tools', 'postinstall', 'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs');
  if (existsSync(verifierPath)) {
    const { verifyUiPatchedDependencies } = await import(pathToFileURL(verifierPath).href);
    const failures = [];
    try {
      verifyUiPatchedDependencies({ uiPackageDir: componentDir });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    const tasksPath = join(componentDir, 'tools', 'resolveUiPostinstallTasks.mjs');
    if (existsSync(tasksPath)) {
      const { resolveUiPostinstallTasks } = await import(pathToFileURL(tasksPath).href);
      const tasks = resolveUiPostinstallTasks({ env });
      // These producers are mandatory. Other vendored editors/workers retain
      // their postinstall owner's explicit best-effort/fallback contract.
      const required = [
        ...(tasks.includes('setup-skia-web') ? ['public/canvaskit.wasm'] : []),
      ];
      for (const path of required) {
        const output = join(componentDir, path);
        const info = await stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info?.isFile() || info.size === 0) failures.push(`Missing or empty UI postinstall asset: ${output}`);
      }
    }
    return { failures: [...failures, ...staleFailures], freshness };
  }
  // Installed/non-checkout contexts may not carry the source verifier.
  const packageDirs = [...new Set([
    join(componentDir, 'node_modules', 'react-native-enriched-markdown'),
    join(installDir, 'node_modules', 'react-native-enriched-markdown'),
  ])].filter(dir => existsSync(dir));
  if (packageDirs.length === 0) packageDirs.push(join(componentDir, 'node_modules', 'react-native-enriched-markdown'));
  return { failures: [...packageDirs.map(dir => join(dir, 'lib', 'module', 'web', 'streamingReveal.js'))
    .filter(file => !existsSync(file)), ...staleFailures], freshness };
}

export async function inspectUiPostinstallOutputs(componentDir, installDir, options) {
  return (await inspectUiPostinstallState(componentDir, installDir, options)).failures;
}

// Both stage-zero/source-test installs and full PM preparation consume this
// owner. It must load before cli-common or other workspace dist exists.
export async function ensureUiPostinstallOutputs(componentDir, installDir, {
  quiet = false,
  force = false,
  env = process.env,
  signal,
  runPostinstall,
  restoreDependencies,
} = {}) {
  const manifestPath = join(componentDir, 'package.json');
  if (!existsSync(manifestPath)) return;
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (pkg?.name !== '@happier-dev/app' || typeof pkg?.scripts?.['postinstall:real'] !== 'string') return;
  await waitForDependencyRefreshWriter({ installDir, env, signal });
  const inspection = await inspectUiPostinstallState(componentDir, installDir, { env });
  if (!force && inspection.failures.length === 0) return;
  return await withDependencyRefreshLock({ installDir, env, signal,
    isRequired: force ? undefined : async () => (await inspectUiPostinstallState(componentDir, installDir, { env })).failures.length > 0,
  }, async () => {
    // Another preparer may already have repaired the outputs while we waited.
    const before = await inspectUiPostinstallState(componentDir, installDir, { env });
    if (!force && before.failures.length === 0) return;
    if (!quiet) console.log('[local] repairing happier-ui postinstall outputs...');
    const postinstallEnv = { ...env,
      HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: env.HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY ?? '1' };
    // Real output failures and forced preparation keep the full repair path.
    // Source-input changes alone run only their affected active producer tasks.
    if (!force && before.freshness?.stale.length > 0
      && before.failures.length === before.freshness.stale.length) {
      postinstallEnv.HAPPIER_UI_POSTINSTALL_TASKS = JSON.stringify(before.freshness.stale);
    } else delete postinstallEnv.HAPPIER_UI_POSTINSTALL_TASKS;
    await markDependencyMutation({ installDir, env, output: 'ui-dependency-outputs' });
    let restoredDependencies = false;
    try {
      await runPostinstall(postinstallEnv);
    } catch {
      // Changed patch inputs can leave a mixed tree. Re-extract pristine bytes
      // through the caller's PM adapter, then retry the same UI postinstall.
      if (!quiet) console.log('[local] repairing mixed happier-ui patched dependency bytes...');
      try { await restoreDependencies(); }
      catch (error) { signal?.throwIfAborted(); throw dependencyInstallationFailure(error); }
      restoredDependencies = true;
      await runPostinstall(postinstallEnv);
    }
    const failures = await inspectUiPostinstallOutputs(componentDir, installDir, { env, checkFreshness: false });
    if (failures.length > 0) {
      throw new Error(`[local] happier-ui postinstall completed without satisfying patched dependency readiness:\n${failures.map(failure => `- ${failure}`).join('\n')}`);
    }
    if (restoredDependencies && !isDependencyRefreshDisabled(env)) await removeInstalledDependencyQuarantine(installDir);
    if (before.freshness) {
      // Admit the inputs actually consumed. A source edit during the subprocess
      // remains stale for the next preparation rather than certifying new bytes.
      await writeJsonAtomic(before.freshness.markerPath, { version: 1, tasks: before.freshness.fingerprints });
    }
  });
}
