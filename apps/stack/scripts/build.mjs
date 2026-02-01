import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled, pmExecBin, requireDir } from './utils/proc/pm.mjs';
import { resolveServerPortFromEnv } from './utils/server/urls.mjs';
import { dirname, join } from 'node:path';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tailscaleServeHttpsUrl } from './tailscale.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, wantsExpoClearCache } from './utils/expo/expo.mjs';
import { expoExec } from './utils/expo/command.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';

/**
 * Build a lightweight static web UI bundle (no Expo dev server).
 *
 * Output directory default: ~/.happy/stacks/main/ui (legacy: ~/.happy/local/ui)
 * Server will serve it at / when HAPPY_SERVER_UI_DIR is set.
 * (Legacy /ui paths are redirected to /.)
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--tauri', '--no-tauri', '--no-ui'], json: true },
      text: [
        '[build] usage:',
        '  hapsta build [--tauri] [--json]',
        '  node scripts/build.mjs [--tauri|--no-tauri] [--no-ui] [--json]',
        '',
        'note:',
        '  If run from inside the Happy UI checkout/worktree, the build uses that checkout.',
      ].join('\n'),
    });
    return;
  }
  const rootDir = getRootDir(import.meta.url);

  // If invoked from inside the Happy UI checkout/worktree, prefer that directory without requiring `hapsta wt use ...`.
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd: getInvokedCwd(process.env),
    components: ['happy'],
  });
  if (inferred?.component === 'happy') {
    if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
      process.env.HAPPIER_STACK_REPO_DIR = inferred.repoDir;
    }
  }

  // Optional: skip building the web UI bundle.
  //
  // This is useful for evidence capture flows that validate non-UI components (e.g. `happy-cli`)
  // but still require a "build" step.
  const skipUi = flags.has('--no-ui');

  const serverPort = resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });

  // For Tauri builds we embed an explicit API base URL (tauri:// origins cannot use window.location.origin).
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;

  const outDir = process.env.HAPPIER_STACK_UI_BUILD_DIR?.trim()
    ? process.env.HAPPIER_STACK_UI_BUILD_DIR.trim()
    : join(getDefaultAutostartPaths().baseDir, 'ui');

  // UI is served at root; /ui redirects to /.

  if (skipUi) {
    // Ensure the output dir exists so server-light doesn't crash if used, but do not run Expo export.
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, '.hapsta-build-skipped'), 'no-ui\n', 'utf-8');
    if (json) {
      printResult({ json, data: { ok: true, outDir, skippedUi: true, tauriBuilt: false } });
    } else {
      console.log(`[local] skipping UI export (--no-ui); created empty UI dir at ${outDir}`);
    }
    return;
  }

  const uiDir = getComponentDir(rootDir, 'happy');
  await requireDir('happy', uiDir);

  await ensureDepsInstalled(uiDir, 'happy');

  // Clean output to avoid stale assets.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log(`[local] exporting web UI to ${outDir}...`);

  // Build for root hosting (the server redirects /ui -> /).
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    EXPO_PUBLIC_DEBUG: '0',
    // Leave empty for web export so the app uses window.location.origin at runtime.
    // (Important for Tailscale: a phone loading `http://100.x.y.z:3005` must not call `http://localhost:3005`.)
    EXPO_PUBLIC_HAPPY_SERVER_URL: '',
  };

  // Expo CLI is available via node_modules/.bin once dependencies are installed.
  {
    const paths = getExpoStatePaths({
      baseDir: getDefaultAutostartPaths().baseDir,
      kind: 'ui-export',
      projectDir: uiDir,
      stateFileName: 'ui.export.state.json',
    });
    await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir: paths.tmpDir });
    const args = ['export', '--platform', 'web', '--output-dir', outDir, ...(wantsExpoClearCache({ env }) ? ['-c'] : [])];
    await expoExec({ dir: uiDir, args, env, ensureDepsLabel: 'happy' });
  }

  if (json) {
    printResult({ json, data: { ok: true, outDir, tauriBuilt: false } });
  } else {
  console.log('[local] UI build complete');
  }

  //
  // Tauri build (optional)
  //
  // Default: do NOT build Tauri (it's slow and requires extra toolchain).
  // Enable explicitly with:
  // - `hapsta build -- --tauri`, or
  // - `HAPPIER_STACK_BUILD_TAURI=1`
  const envBuildTauri = (process.env.HAPPIER_STACK_BUILD_TAURI ?? '').trim();
  const buildTauriFromEnv = envBuildTauri !== '' ? envBuildTauri !== '0' : false;
  const buildTauri = !flags.has('--no-tauri') && (flags.has('--tauri') || buildTauriFromEnv);
  if (!buildTauri) {
    return;
  }

  // Default to debug builds for local development so devtools are available.
  const tauriDebug = (process.env.HAPPIER_STACK_TAURI_DEBUG ?? '1') === '1';

  // Choose the API endpoint the Tauri app should use.
  //
  // Priority:
  // 1) HAPPIER_STACK_TAURI_SERVER_URL (explicit override)
  // 2) If available, a Tailscale Serve https://*.ts.net URL (portable across machines on the same tailnet)
  // 3) Fallback to internal loopback (same-machine)
  const tauriServerUrlOverride = process.env.HAPPIER_STACK_TAURI_SERVER_URL?.trim()
    ? process.env.HAPPIER_STACK_TAURI_SERVER_URL.trim()
    : '';
  const preferTailscale = (process.env.HAPPIER_STACK_TAURI_PREFER_TAILSCALE ?? '1') !== '0';
  const tailscaleUrl = preferTailscale ? await tailscaleServeHttpsUrl() : null;
  const tauriServerUrl = tauriServerUrlOverride || tailscaleUrl || internalServerUrl;

  const tauriDistDir = process.env.HAPPIER_STACK_TAURI_UI_DIR?.trim()
    ? process.env.HAPPIER_STACK_TAURI_UI_DIR.trim()
    : join(uiDir, 'dist');

  await rm(tauriDistDir, { recursive: true, force: true });
  await mkdir(tauriDistDir, { recursive: true });

  console.log(`[local] exporting web UI for Tauri to ${tauriDistDir}...`);

  const tauriEnv = {
    ...process.env,
    NODE_ENV: 'production',
    EXPO_PUBLIC_DEBUG: '0',
    // In Tauri, window.location.origin is a tauri:// origin, so we must hardcode the API base.
    EXPO_PUBLIC_HAPPY_SERVER_URL: tauriServerUrl,
    // Some parts of the app use EXPO_PUBLIC_SERVER_URL; keep them aligned.
    EXPO_PUBLIC_SERVER_URL: tauriServerUrl,
    // For the Tauri bundle we want root-relative assets (no /ui baseUrl), so do not set EXPO_PUBLIC_WEB_BASE_URL
  };
  delete tauriEnv.EXPO_PUBLIC_WEB_BASE_URL;

  {
    const paths = getExpoStatePaths({
      baseDir: getDefaultAutostartPaths().baseDir,
      kind: 'ui-export-tauri',
      projectDir: uiDir,
      stateFileName: 'ui.export.tauri.state.json',
    });
    await ensureExpoIsolationEnv({ env: tauriEnv, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir: paths.tmpDir });
  }

  await expoExec({
    dir: uiDir,
    args: [
      'export',
      '--platform',
      'web',
      '--output-dir',
      tauriDistDir,
      // Important: clear bundler cache so EXPO_PUBLIC_* inlining doesn't reuse
      // the previous (web) export's transform results.
      '-c',
    ],
    env: tauriEnv,
    ensureDepsLabel: 'happy',
  });

  // Build the Tauri app using a generated config that skips upstream beforeBuildCommand (which uses yarn).
  const tauriConfigPath = join(uiDir, 'src-tauri', 'tauri.conf.json');
  const tauriConfigRaw = await readFile(tauriConfigPath, 'utf-8');
  const tauriConfig = JSON.parse(tauriConfigRaw);
  tauriConfig.build = tauriConfig.build ?? {};
  // Prefer the upstream relative dist dir when possible (less surprising for Tauri tooling).
  tauriConfig.build.frontendDist = tauriDistDir === join(uiDir, 'dist') ? '../dist' : tauriDistDir;
  tauriConfig.build.beforeBuildCommand = null;
  tauriConfig.build.beforeDevCommand = null;

  // Build a separate "local" app so it doesn't reuse previous storage (server URL, auth, etc).
  // This avoids needing any changes in the Happy source code to override a previously saved server.
  tauriConfig.identifier = process.env.HAPPIER_STACK_TAURI_IDENTIFIER?.trim()
    ? process.env.HAPPIER_STACK_TAURI_IDENTIFIER.trim()
    : 'com.happier.stack';
  tauriConfig.productName = process.env.HAPPIER_STACK_TAURI_PRODUCT_NAME?.trim()
    ? process.env.HAPPIER_STACK_TAURI_PRODUCT_NAME.trim()
    : 'Hapsta';
  if (tauriConfig.app?.windows?.length) {
    tauriConfig.app.windows = tauriConfig.app.windows.map((w) => ({
      ...w,
      title: tauriConfig.productName ?? w.title,
    }));
  }

  if (tauriDebug) {
    // Enable devtools in debug builds (useful for troubleshooting connectivity).
    tauriConfig.app = tauriConfig.app ?? {};
    tauriConfig.app.windows = Array.isArray(tauriConfig.app.windows) ? tauriConfig.app.windows : [];
    if (tauriConfig.app.windows.length > 0) {
      tauriConfig.app.windows = tauriConfig.app.windows.map((w) => ({ ...w, devtools: true }));
    }
  }

  const generatedConfigPath = join(getDefaultAutostartPaths().baseDir, 'tauri.conf.happier-stack.json');
  await mkdir(dirname(generatedConfigPath), { recursive: true });
  await writeFile(generatedConfigPath, JSON.stringify(tauriConfig, null, 2), 'utf-8');

  console.log('[local] building Tauri app...');
  const cargoTargetDir = join(getDefaultAutostartPaths().baseDir, 'tauri-target');
  await mkdir(cargoTargetDir, { recursive: true });

  const tauriBuildEnv = {
    ...process.env,
    // Fixes builds after moving the repo by isolating cargo outputs from old absolute paths.
    CARGO_TARGET_DIR: cargoTargetDir,
    // Newer Tauri CLI parses CI as a boolean; many environments set CI=1 which fails.
    CI: 'false',
  };

  const tauriArgs = ['build', '--config', generatedConfigPath];
  if (tauriDebug) {
    tauriArgs.push('--debug');
  }
  await pmExecBin({ dir: uiDir, bin: 'tauri', args: tauriArgs, env: tauriBuildEnv });
  if (json) {
    printResult({ json, data: { ok: true, outDir, tauriBuilt: true, tauriServerUrl } });
  } else {
  console.log('[local] Tauri build complete');
  }
}

main().catch((err) => {
  console.error('[local] build failed:', err);
  process.exit(1);
});
