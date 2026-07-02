import { accessSync, constants, existsSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolvePreferredStackServerIdFromCliSettings } from '../auth/credentials_paths.mjs';
import { applyStackActiveServerScopeEnv } from '../auth/stable_scope_id.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRepoDir } from '../paths/paths.mjs';
import { resolveCommandInvocation } from '../process/resolveCommandInvocation.mjs';

export function resolveTauriDevUrl({ expoPort, defaultPort = 8081 } = {}) {
  const port = Number(expoPort);
  const resolvedPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : defaultPort;
  return `http://localhost:${resolvedPort}`;
}

export function buildTauriDevInvocation({
  expoPort,
  configPath = 'src-tauri/tauri.publicdev.conf.json',
} = {}) {
  const devUrl = resolveTauriDevUrl({ expoPort });
  return {
    command: 'tauri',
    args: [
      'dev',
      '--no-dev-server-wait',
      '--config',
      configPath,
      '-c',
      JSON.stringify({
        build: {
          beforeDevCommand: '',
          devUrl,
          frontendDist: null,
        },
      }),
    ],
  };
}

function resolveCargoBinDir({ env = process.env, resolveUserHomeDir } = {}) {
  const input = env && typeof env === 'object' ? env : process.env;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const cargoBinaryName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

  let resolvedHomeDir = '';
  if (typeof resolveUserHomeDir === 'function') {
    resolvedHomeDir = String(resolveUserHomeDir()).trim();
  }
  if (!resolvedHomeDir) {
    try {
      resolvedHomeDir = String(os.userInfo()?.homedir ?? '').trim();
    } catch {
      resolvedHomeDir = '';
    }
  }

  // Stack tooling sometimes isolates HOME (for cache isolation / stack-scoped state) while Rust toolchains
  // remain installed under the real user home. When HOME is isolated, prefer the resolved user home cargo
  // toolchain over any cargo shim present on PATH.
  const envHome = String(input.HOME ?? input.USERPROFILE ?? '').trim();
  const homeIsolated = Boolean(envHome && resolvedHomeDir && envHome !== resolvedHomeDir);

  const cargoHomeFromEnv = String(input.CARGO_HOME ?? '').trim();
  if (cargoHomeFromEnv) {
    const cargoHomeBinDir = join(cargoHomeFromEnv, 'bin');
    const cargoHomeCandidate = join(cargoHomeBinDir, cargoBinaryName);
    if (existsSync(cargoHomeCandidate)) {
      try {
        accessSync(cargoHomeCandidate, constants.X_OK);
        return cargoHomeBinDir;
      } catch {
        // ignore non-executable candidates
      }
    }
  }

  if (homeIsolated && resolvedHomeDir) {
    const resolvedCargoBinDir = join(resolvedHomeDir, '.cargo', 'bin');
    const resolvedCargoCandidate = join(resolvedCargoBinDir, cargoBinaryName);
    if (existsSync(resolvedCargoCandidate)) {
      try {
        accessSync(resolvedCargoCandidate, constants.X_OK);
        return resolvedCargoBinDir;
      } catch {
        // ignore non-executable candidates
      }
    }
  }

  const pathEntries = String(input.PATH ?? '')
    .split(delimiter)
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);

  for (const dir of pathEntries) {
    const candidate = join(dir, cargoBinaryName);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
      return dir;
    } catch {
      // ignore non-executable candidates
    }
  }

  // Default rustup install location (non-isolated HOME, or when PATH scanning missed it).
  const cargoHome = join(resolvedHomeDir || os.homedir(), '.cargo');
  const cargoHomeBin = join(cargoHome, 'bin');
  const cargoHomeCandidate = join(cargoHomeBin, cargoBinaryName);
  if (existsSync(cargoHomeCandidate)) {
    try {
      accessSync(cargoHomeCandidate, constants.X_OK);
      return cargoHomeBin;
    } catch {
      // ignore non-executable candidates
    }
  }

  return '';
}

export function assertCargoAvailableForTauri({ env = process.env, resolveUserHomeDir } = {}) {
  const cargoBinDir = resolveCargoBinDir({ env, resolveUserHomeDir });
  if (cargoBinDir) {
    const input = env && typeof env === 'object' ? env : process.env;
    const cargoBinaryName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
    const cargoBinaryPath = join(cargoBinDir, cargoBinaryName);

    const res = spawnSync(cargoBinaryPath, ['--version'], {
      env: input,
      stdio: 'ignore',
      timeout: 8_000,
    });
    if (res.error) {
      const code = res.error && typeof res.error === 'object' ? String(res.error.code ?? '') : '';
      throw new Error(
        [
          '[tauri-dev] cargo was discovered but failed to execute.',
          `Resolved cargo: ${cargoBinaryPath}.`,
          code ? `Error code: ${code}.` : '',
          'Fix: ensure your Rust toolchain is correctly installed (rustup recommended) and retry.',
        ].filter(Boolean).join(' ')
      );
    }
    if (typeof res.status === 'number' && res.status !== 0) {
      throw new Error(
        [
          '[tauri-dev] cargo was discovered but returned a non-zero exit code.',
          `Resolved cargo: ${cargoBinaryPath}.`,
          `Exit code: ${res.status}.`,
          'Fix: ensure your Rust toolchain is correctly installed (rustup recommended) and retry.',
        ].join(' ')
      );
    }
    return cargoBinDir;
  }

  const input = env && typeof env === 'object' ? env : process.env;
  const cargoHome = String(input.CARGO_HOME ?? '').trim();
  const homeHint = (() => {
    let resolvedHomeDir = '';
    if (typeof resolveUserHomeDir === 'function') {
      resolvedHomeDir = String(resolveUserHomeDir()).trim();
    }
    if (!resolvedHomeDir) {
      try {
        resolvedHomeDir = String(os.userInfo()?.homedir ?? '').trim();
      } catch {
        resolvedHomeDir = '';
      }
    }
    return join(resolvedHomeDir || os.homedir(), '.cargo', 'bin');
  })();

  throw new Error(
    [
      '[tauri-dev] cargo was not found on PATH or in the Rust toolchain locations used by Tauri.',
      `Looked for cargo in ${cargoHome ? `${cargoHome}/bin and ` : ''}${homeHint} and along PATH.`,
      'Install Rust with rustup or add cargo to PATH, then retry the Tauri pane.',
    ].join(' ')
  );
}

function isExecutablePath(path) {
  const candidate = String(path ?? '').trim();
  if (!candidate) return false;
  if (!existsSync(candidate)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function looksLikeFilesystemPath(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (s.includes('/') || s.includes('\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(s);
}

function prependPathEntry(env, entry) {
  const candidate = String(entry ?? '').trim();
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const host = String(process.env.PATH ?? '')
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const merged = [candidate, ...current, ...host].filter(Boolean);
  const next = [];
  const seen = new Set();
  for (const value of merged) {
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  if (next.length === 0) return env;
  env.PATH = next.join(delimiter);
  if (process.platform === 'win32') {
    env.Path = env.PATH;
  }
  return env;
}

function resolveNodeBinDir() {
  return dirname(process.execPath);
}

function resolveUserHomeDirValue({ env = process.env, resolveUserHomeDir } = {}) {
  if (typeof resolveUserHomeDir === 'function') {
    const resolved = String(resolveUserHomeDir()).trim();
    if (resolved) return resolved;
  }

  try {
    const userInfoHome = String(os.userInfo()?.homedir ?? '').trim();
    if (userInfoHome) return userInfoHome;
  } catch {
    // ignore
  }

  const input = env && typeof env === 'object' ? env : process.env;
  return String(input.HOME ?? input.USERPROFILE ?? '').trim();
}

function resolveStackScopedServerUrl(env) {
  const serverPort = Number(String(env.HAPPIER_STACK_SERVER_PORT ?? '').trim());
  if (Number.isFinite(serverPort) && serverPort > 0) {
    return `http://127.0.0.1:${Math.floor(serverPort)}`;
  }

  return String(env.HAPPIER_SERVER_URL ?? '').trim();
}

function isLoopbackServerUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = String(url.hostname ?? '').trim().toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

function applyStackScopedServerDefaults(env, { preferStackDefaults = false } = {}) {
  const nextEnv = env;
  const stackCliHomeDir = String(nextEnv.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  const stackName = String(nextEnv.HAPPIER_STACK_STACK ?? '').trim();
  const stackEnvFile = String(nextEnv.HAPPIER_STACK_ENV_FILE ?? '').trim();
  const hasStackContext = Boolean(stackCliHomeDir || stackName || stackEnvFile);
  if (!hasStackContext) {
    return nextEnv;
  }

  const resolvedServerUrl = resolveStackScopedServerUrl(nextEnv);
  const existingServerUrl = String(nextEnv.HAPPIER_SERVER_URL ?? '').trim();
  const shouldOverrideServerUrl =
    preferStackDefaults || !existingServerUrl || isLoopbackServerUrl(existingServerUrl);
  if (resolvedServerUrl && shouldOverrideServerUrl) {
    nextEnv.HAPPIER_SERVER_URL = resolvedServerUrl;
  }

  const stackWebappUrl = (() => {
    const serverPort = Number(String(nextEnv.HAPPIER_STACK_SERVER_PORT ?? '').trim());
    return Number.isFinite(serverPort) && serverPort > 0 ? `http://localhost:${Math.floor(serverPort)}` : '';
  })();
  const existingWebappUrl = String(nextEnv.HAPPIER_WEBAPP_URL ?? '').trim();
  const shouldOverrideWebappUrl = shouldOverrideServerUrl || isLoopbackServerUrl(existingWebappUrl);
  if (stackWebappUrl && shouldOverrideWebappUrl) {
    nextEnv.HAPPIER_WEBAPP_URL = stackWebappUrl;
  }

  const existingActiveServerId = String(nextEnv.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  const shouldResolveActiveServerId = !existingActiveServerId || shouldOverrideServerUrl;
  if (shouldResolveActiveServerId) {
    const scopedEnv = applyStackActiveServerScopeEnv({
      env: nextEnv,
      stackName: stackName || null,
      cliIdentity: (nextEnv.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
    });
    const settingsServerId =
      stackCliHomeDir && resolvedServerUrl
        ? resolvePreferredStackServerIdFromCliSettings({
            cliHomeDir: stackCliHomeDir,
            serverUrl: resolvedServerUrl,
            env: scopedEnv,
          })
        : '';
    nextEnv.HAPPIER_ACTIVE_SERVER_ID =
      settingsServerId || String(scopedEnv.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  }

  return nextEnv;
}

export function buildTauriRuntimeEnv({ env = process.env, resolveUserHomeDir } = {}) {
  const nextEnv = { ...(env && typeof env === 'object' ? env : process.env) };
  const stackName = String(nextEnv.HAPPIER_STACK_STACK ?? '').trim();
  const stackCliHomeDir = String(nextEnv.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  if (stackCliHomeDir && !String(nextEnv.HAPPIER_HOME_DIR ?? '').trim()) {
    nextEnv.HAPPIER_HOME_DIR = stackCliHomeDir;
  }
  const existingStorageScope = String(nextEnv.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? '').trim();
  const preferredStorageScope = String(
    nextEnv.HAPPIER_STACK_STORAGE_SCOPE
    ?? stackName,
  ).trim();
  if (!existingStorageScope && preferredStorageScope) {
    nextEnv.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = preferredStorageScope;
  }
  applyStackScopedServerDefaults(nextEnv, {
    preferStackDefaults: Boolean(String(nextEnv.HAPPIER_STACK_ENV_FILE ?? '').trim()),
  });
  const nodeBinDir = resolveNodeBinDir();
  if (nodeBinDir) {
    prependPathEntry(nextEnv, nodeBinDir);
  }
  const resolvedHomeDir = resolveUserHomeDirValue({ env: nextEnv, resolveUserHomeDir });
  const cargoBinDir = resolveCargoBinDir({ env: nextEnv, resolveUserHomeDir });
  if (cargoBinDir) {
    prependPathEntry(nextEnv, cargoBinDir);
    const cargoBinaryName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
    const resolvedCargoBinary = join(cargoBinDir, cargoBinaryName);
    const existingCargo = String(nextEnv.CARGO ?? '').trim();
    const shouldOverrideExistingCargo =
      !existingCargo
      || !looksLikeFilesystemPath(existingCargo)
      || !isExecutablePath(existingCargo);
    if (shouldOverrideExistingCargo) {
      nextEnv.CARGO = resolvedCargoBinary;
    }
    if (resolvedHomeDir) {
      if (String(nextEnv.HOME ?? '').trim() !== resolvedHomeDir) {
        nextEnv.HOME = resolvedHomeDir;
      }
      if (String(nextEnv.USERPROFILE ?? '').trim() !== resolvedHomeDir) {
        nextEnv.USERPROFILE = resolvedHomeDir;
      }
    }
    const expectedCargoBinDir = resolvedHomeDir ? join(resolvedHomeDir, '.cargo', 'bin') : '';
    if (expectedCargoBinDir && cargoBinDir === expectedCargoBinDir) {
      if (!String(nextEnv.CARGO_HOME ?? '').trim()) {
        nextEnv.CARGO_HOME = dirname(cargoBinDir);
      }
      if (!String(nextEnv.RUSTUP_HOME ?? '').trim()) {
        nextEnv.RUSTUP_HOME = join(resolvedHomeDir, '.rustup');
      }
    }

    if (!String(nextEnv.RUSTUP_HOME ?? '').trim()) {
      const cargoHome = String(nextEnv.CARGO_HOME ?? '').trim();
      if (cargoHome && cargoBinDir === join(cargoHome, 'bin')) {
        const normalizedCargoHome = cargoHome.replaceAll('\\', '/').replace(/\/+$/, '');
        if (normalizedCargoHome.endsWith('/.cargo')) {
          const rustupHome = join(dirname(cargoHome), '.rustup');
          if (rustupHome) {
            nextEnv.RUSTUP_HOME = rustupHome;
          }
        }
      }
    }
  } else {
    prependPathEntry(nextEnv, '');
  }
  return nextEnv;
}

function isAbsolutePath(p) {
  const s = String(p ?? '').trim();
  if (!s) return false;
  if (s.startsWith('/')) return true;
  if (s.startsWith('\\\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(s);
}

function normalizeConfigPathForSrcTauriCwd(configPath) {
  const raw = String(configPath ?? '').trim();
  if (!raw) return raw;
  if (isAbsolutePath(raw)) return raw;
  const normalized = raw.replaceAll('\\', '/');
  if (normalized.startsWith('src-tauri/')) {
    return normalized.slice('src-tauri/'.length);
  }
  if (normalized.startsWith('./src-tauri/')) {
    return normalized.slice('./src-tauri/'.length);
  }
  return raw;
}

export function buildStackTauriDevProcessInvocation({
  rootDir,
  repoRootDir,
  uiDir,
  env = process.env,
  stackEnv = null,
  configPath = 'tauri.publicdev.conf.json',
  configOverride,
  resolveUserHomeDir,
} = {}) {
  // Stack-owned Tauri launches must prefer the authoritative stack snapshot over any
  // stale shell process env so they inherit the correct stack-scoped server settings.
  const mergedEnv = {
    ...(env && typeof env === 'object' ? env : process.env),
    ...(stackEnv && typeof stackEnv === 'object' ? stackEnv : {}),
  };
  const runtimeEnv = buildTauriRuntimeEnv({
    env: mergedEnv,
    resolveUserHomeDir,
  });
  if (stackEnv && typeof stackEnv === 'object' && Object.keys(stackEnv).length > 0) {
    applyStackScopedServerDefaults(runtimeEnv, { preferStackDefaults: true });
  }
  const cargoBinDir = assertCargoAvailableForTauri({ env: runtimeEnv, resolveUserHomeDir });
  const cargoBinaryName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const cargoBinaryPath = join(cargoBinDir, cargoBinaryName);
  const repoRoot = String(repoRootDir ?? '').trim() || getRepoDir(rootDir, env);
  const resolvedUiDir = String(uiDir ?? '').trim() || getComponentDir(rootDir, 'happier-ui', env);
  const cwd = join(resolvedUiDir, 'src-tauri');
  const resolvedConfigPath = normalizeConfigPathForSrcTauriCwd(configPath);
  runtimeEnv.CARGO_TARGET_DIR = join(getDefaultAutostartPaths(env).baseDir, 'tauri-target');
  const tauriEntrypoint = (() => {
    const preferred = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    if (existsSync(preferred)) return preferred;
    const fallback = join(repoRoot, 'node_modules', '.bin', 'tauri');
    if (existsSync(fallback)) return fallback;
    return preferred;
  })();
  const normalizedConfigOverride = (() => {
    if (!configOverride || typeof configOverride !== 'object') return configOverride;
    const override = { ...configOverride };
    const build = override.build && typeof override.build === 'object' ? { ...override.build } : null;
    if (build && typeof build.devUrl === 'string' && !Object.prototype.hasOwnProperty.call(build, 'frontendDist')) {
      build.frontendDist = null;
      override.build = build;
    }
    return override;
  })();
  const invocation = resolveCommandInvocation({
    command: process.execPath,
    args: [
      tauriEntrypoint,
      'dev',
      '--runner',
      cargoBinaryPath,
      '--no-dev-server-wait',
      '--config',
      resolvedConfigPath,
      ...(normalizedConfigOverride == null ? [] : ['-c', JSON.stringify(normalizedConfigOverride)]),
    ],
    env: runtimeEnv,
  });

  return {
    ...invocation,
    cwd,
    env: runtimeEnv,
  };
}
