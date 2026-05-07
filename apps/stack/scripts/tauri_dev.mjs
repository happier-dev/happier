import './utils/env/env.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { getComponentDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureWorkspacePackagesBuiltForComponent, pmExecBin } from './utils/proc/pm.mjs';
import { spawnProc } from './utils/proc/proc.mjs';
import { getStackRuntimeStatePath, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { sanitizeDnsLabel } from './utils/net/dns.mjs';
import { buildStackTauriDevConfig, resolveStackTauriDevUrl } from './utils/tauri/dev_runtime.mjs';
import { waitForExpoMetroRunning } from './utils/expo/expo.mjs';
import {
  assertCargoAvailableForTauri,
  buildStackTauriDevProcessInvocation,
  buildTauriRuntimeEnv,
} from './utils/dev/tauri_dev.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';

function buildDefaultStackTauriEnv(env, stackName) {
  const nextEnv = { ...env };
  const normalizedStack = sanitizeDnsLabel(String(stackName ?? '').trim());
  if (!normalizedStack) {
    return nextEnv;
  }

  if (!String(nextEnv.HAPPIER_STACK_TAURI_IDENTIFIER ?? '').trim()) {
    nextEnv.HAPPIER_STACK_TAURI_IDENTIFIER = `com.happier.stack.${normalizedStack}`;
  }
  if (!String(nextEnv.HAPPIER_STACK_TAURI_PRODUCT_NAME ?? '').trim()) {
    nextEnv.HAPPIER_STACK_TAURI_PRODUCT_NAME = `Happier (${normalizedStack})`;
  }
  return nextEnv;
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function wantsTauriWaitForExpo(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_TAURI_WAIT_FOR_EXPO ?? '').trim();
  if (raw) return raw !== '0';
  return true;
}

function parsePortFromUrl(rawUrl, fallbackPort) {
  try {
    const url = new URL(String(rawUrl ?? '').trim());
    const p = Number(url.port || fallbackPort);
    return Number.isFinite(p) && p > 0 ? Math.floor(p) : fallbackPort;
  } catch {
    return fallbackPort;
  }
}

async function maybeReadStackEnvFileObject({ stackName, env = process.env } = {}) {
  const name = String(stackName ?? '').trim();
  if (!name) return {};

  const explicitEnvFilePath = String(env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
  if (explicitEnvFilePath && existsSync(explicitEnvFilePath)) {
    try {
      const raw = await readFile(explicitEnvFilePath, 'utf-8');
      if (String(raw ?? '').trim()) return parseEnvToObject(raw);
    } catch {
      // ignore
    }
  }

  try {
    const { envPath } = resolveStackEnvPath(name, env);
    const raw = await readFile(envPath, 'utf-8');
    if (!String(raw ?? '').trim()) return {};
    return parseEnvToObject(raw);
  } catch {
    return {};
  }
}

function resolveTauriUiDirForDev({ rootDir, env = process.env } = {}) {
  const inputEnv = env && typeof env === 'object' ? env : process.env;
  const primary = getComponentDir(rootDir, 'happier-ui', inputEnv);
  if (existsSync(join(primary, 'src-tauri', 'tauri.conf.json'))) {
    return primary;
  }

  const fallbackRepoDir = String(
    inputEnv.HAPPIER_STACK_CLI_ROOT_DIR ??
      inputEnv.HAPPIER_STACK_INVOKED_CWD ??
      ''
  ).trim();
  if (!fallbackRepoDir) {
    return primary;
  }

  const fallback = getComponentDir(rootDir, 'happier-ui', {
    ...inputEnv,
    HAPPIER_STACK_REPO_DIR: fallbackRepoDir,
  });
  if (existsSync(join(fallback, 'src-tauri', 'tauri.conf.json'))) {
    return fallback;
  }

  return primary;
}

function assertTauriUiDirForDev(uiDir) {
  const dir = String(uiDir ?? '').trim();
  const tauriDir = join(dir, 'src-tauri');
  const required = [
    join(tauriDir, 'tauri.conf.json'),
    join(tauriDir, 'tauri.publicdev.conf.json'),
    join(tauriDir, 'Cargo.toml'),
  ];
  if (required.every((p) => existsSync(p))) {
    return {
      tauriDir,
      configPath: required[0],
      publicDevConfigPath: required[1],
      cargoManifestPath: required[2],
    };
  }

  throw new Error(
    [
      '[tauri-dev] expected a Happier repo checkout containing apps/ui/src-tauri, but required files were missing.',
      `Resolved UI dir: ${dir || '(empty)'}.`,
      'Fix: run the command from your repo checkout (or set HAPPIER_STACK_REPO_DIR to it) and retry.',
    ].join(' ')
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const json = wantsJson(argv);
  if (wantsHelp(argv)) {
    printResult({
      json,
      data: { usage: 'node ./apps/stack/scripts/tauri_dev.mjs [--json]', json: true },
      text: [
        '[tauri-dev] usage:',
        '  node ./apps/stack/scripts/tauri_dev.mjs',
        '',
        'notes:',
        '  - Reuses the existing Expo dev server instead of starting a second one.',
        '  - Builds the bundled hsetup sidecar once before launching Tauri.',
        '  - When stack env is present, derives a stack-scoped dev URL and Tauri identifier.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const envWithStackDefaults = buildDefaultStackTauriEnv(process.env, process.env.HAPPIER_STACK_STACK);
  const uiDir = resolveTauriUiDirForDev({ rootDir, env: envWithStackDefaults });
  const uiLayout = assertTauriUiDirForDev(uiDir);
  const repoRootDir = dirname(dirname(uiDir));
  const stackName = String(envWithStackDefaults.HAPPIER_STACK_STACK ?? '').trim();
  const stackEnvFile = stackName ? await maybeReadStackEnvFileObject({ stackName, env: envWithStackDefaults }) : {};
  const stackEnvExpoPort = Number(stackEnvFile.HAPPIER_STACK_EXPO_DEV_PORT ?? '');
  const hasStackEnvExpoPort = Number.isFinite(stackEnvExpoPort) && stackEnvExpoPort > 0;
  const runtimeState = stackName
    ? await readStackRuntimeStateFile(getStackRuntimeStatePath(stackName))
    : null;
  const devUrl = (() => {
    const envExpoPort = Number(envWithStackDefaults.HAPPIER_STACK_EXPO_DEV_PORT ?? '');
    if (Number.isFinite(envExpoPort) && envExpoPort > 0) {
      return `http://localhost:${Math.floor(envExpoPort)}`;
    }
    if (hasStackEnvExpoPort) {
      return `http://localhost:${Math.floor(stackEnvExpoPort)}`;
    }
    return resolveStackTauriDevUrl({
      runtimeState,
      defaultPort: Number(process.env.HAPPIER_STACK_TAURI_DEV_PORT ?? 8081),
    });
  })();
  const resolveUserHomeDir = () => {
    try {
      return String(os.userInfo()?.homedir ?? os.homedir() ?? '').trim();
    } catch {
      return String(os.homedir() ?? '').trim();
    }
  };
  const runtimeEnv = buildTauriRuntimeEnv({
    env: envWithStackDefaults,
    resolveUserHomeDir,
  });
  assertCargoAvailableForTauri({ env: runtimeEnv, resolveUserHomeDir });
  if (String(runtimeEnv.HAPPIER_STACK_TUI ?? '').trim() === '1') {
    const pathEntries = String(runtimeEnv.PATH ?? '')
      .split(process.platform === 'win32' ? ';' : ':')
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
    const pathHead = pathEntries.slice(0, 4).join(process.platform === 'win32' ? ';' : ':');
    // eslint-disable-next-line no-console
    console.log(
      `[tauri-dev] env preflight: HOME=${String(runtimeEnv.HOME ?? '')} CARGO=${String(runtimeEnv.CARGO ?? '')} PATH=${pathHead}${pathEntries.length > 4 ? ':…' : ''}`
    );
  }

  const baseConfig = await readJsonFile(uiLayout.configPath);
  const overlayConfig = await readJsonFile(uiLayout.publicDevConfigPath);
  const mergedConfig = buildStackTauriDevConfig({
    baseConfig,
    overlayConfig,
    devUrl,
    env: envWithStackDefaults,
  });

  // Best-effort: refresh the stack-scoped dev config under the stack storage dir.
  // Some workflows (or older stack tooling) may still refer to this path; keeping it current prevents
  // drift like stale `externalBin` entries causing hard-to-debug native build failures.
  if (!json && stackName) {
    try {
      const stackBaseDir = getDefaultAutostartPaths(envWithStackDefaults).baseDir;
      const stackConfigPath = join(stackBaseDir, 'tauri.dev.stack.json');
      const stackDevConfig = buildStackTauriDevConfig({
        baseConfig,
        overlayConfig,
        devUrl,
        env: envWithStackDefaults,
      });
      stackDevConfig.build = {
        ...(stackDevConfig.build ?? {}),
        beforeDevCommand: null,
        beforeBuildCommand: null,
      };
      if (stackDevConfig.bundle && typeof stackDevConfig.bundle === 'object') {
        stackDevConfig.bundle = {
          ...stackDevConfig.bundle,
          createUpdaterArtifacts: false,
        };
      }
      await mkdir(dirname(stackConfigPath), { recursive: true }).catch(() => {});
      await writeFile(stackConfigPath, JSON.stringify(stackDevConfig, null, 2), 'utf-8');
    } catch {
      // ignore (non-fatal)
    }
  }
  const configPath = uiLayout.publicDevConfigPath;
  const configOverride = {
    identifier: mergedConfig.identifier,
    productName: mergedConfig.productName,
    ...(mergedConfig.app?.windows?.length ? { app: { windows: mergedConfig.app.windows } } : {}),
    ...(mergedConfig.bundle && typeof mergedConfig.bundle === 'object'
      ? { bundle: { createUpdaterArtifacts: mergedConfig.bundle.createUpdaterArtifacts ?? false } }
      : {}),
    build: {
      beforeDevCommand: '',
      devUrl,
    },
  };

  if (json) {
    const tauriInvocation = buildStackTauriDevProcessInvocation({
      rootDir,
      repoRootDir,
      uiDir,
      env: runtimeEnv,
      configPath,
      configOverride,
      resolveUserHomeDir,
    });
    printResult({
      json,
      data: {
        ok: true,
        devUrl,
        uiDir,
        configPath,
        stackName: stackName || null,
        identifier: mergedConfig.identifier ?? null,
        tauri: {
          command: tauriInvocation.command,
          args: tauriInvocation.args,
          cwd: tauriInvocation.cwd,
        },
      },
    });
    return;
  }

  if (wantsTauriWaitForExpo(envWithStackDefaults)) {
    const defaultPort = Number(envWithStackDefaults.HAPPIER_STACK_TAURI_DEV_PORT ?? 8081);
    const expoPort = parsePortFromUrl(devUrl, Number.isFinite(defaultPort) && defaultPort > 0 ? defaultPort : 8081);
    const metro = await waitForExpoMetroRunning({ port: expoPort, env: envWithStackDefaults });
    if (!metro.ok) {
      throw new Error(
        [
          `[tauri-dev] Expo dev server was not reachable on port ${expoPort}.`,
          'Start the UI dev server first (`yarn ui`, `yarn --cwd apps/ui start`, or `yarn tui:with-tauri`) and retry.',
        ].join(' ')
      );
    }
  }

  await ensureWorkspacePackagesBuiltForComponent(uiDir, { quiet: false, env: envWithStackDefaults });
  await pmExecBin({
    dir: uiDir,
    bin: 'tauri:prepare:sidecar',
    env: envWithStackDefaults,
  });

  const tauriInvocation = buildStackTauriDevProcessInvocation({
    rootDir,
    repoRootDir,
    uiDir,
    env: runtimeEnv,
    configPath,
    configOverride,
    resolveUserHomeDir,
  });
  spawnProc('tauri', tauriInvocation.command, tauriInvocation.args, {
    ...(tauriInvocation.env ?? runtimeEnv),
    CI: 'false',
  }, {
    cwd: tauriInvocation.cwd,
    ...(tauriInvocation.windowsVerbatimArguments ? { windowsVerbatimArguments: tauriInvocation.windowsVerbatimArguments } : {}),
  });
}

main().catch((error) => {
  console.error(`[tauri-dev] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
