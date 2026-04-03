// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ensureTauriSigningKeyFile } from './ensure-signing-key-file.mjs';
import { resolveTauriSigningPrivateKeyPassword } from './resolve-signing-key-password.mjs';
import { resolveYarnInvocation } from './resolve-yarn-invocation.mjs';
import { formatPublicReleaseChannelChoices, normalizePublicReleaseChannel } from '../release/lib/public-release-rings.mjs';
import { execFileSyncPortable } from '../lib/exec-file-sync-portable.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function shouldRunLinuxHsetupLddPreflight() {
  const raw = String(process.env.HAPPIER_TAURI_LINUX_HSETUP_LDD_PREFLIGHT ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  return process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * Windows MSI versioning is stricter than plain semver:
 * - pre-release identifiers must be numeric-only
 * - numeric identifiers must fit within a 16-bit unsigned integer (<= 65535)
 *
 * Our dev/preview build versions use `-dev.<n>` / `-preview.<n>`, which fails MSI packaging.
 * This normalizes those versions to `-<n>` for Windows only.
 *
 * @param {string} buildVersion
 * @returns {string}
 */
export function normalizeTauriBuildVersionForWindows(buildVersion) {
  const raw = String(buildVersion ?? '').trim();
  if (!raw) return raw;

  const match = raw.match(/^(\d+\.\d+\.\d+)-(?:dev|preview)\.(\d+)$/);
  if (!match) return raw;

  const base = match[1];
  const nRaw = match[2];
  const n = Number.parseInt(String(nRaw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return `${base}-1`;

  const clamped = Math.min(65535, n);
  return `${base}-${clamped}`;
}

/**
 * linuxdeploy's AppImage plugin is (still) brittle around spaces/shell quoting in artifact names.
 * Tauri uses `productName` as the basis for bundle filenames, so we override it on Linux for
 * preview-like lanes while keeping the human-friendly window title untouched (set in config).
 *
 * @param {{ environment: string }} opts
 * @returns {string | null}
 */
export function resolveLinuxProductNameOverride(opts) {
  const env = String(opts.environment ?? '').trim();
  if (!env || env === 'production') return null;
  if (env === 'dev' || env === 'publicdev') return 'HappierDev';
  if (env === 'preview') return 'HappierPreview';
  return null;
}

/**
 * Linux AppImage bundling uses linuxdeploy + appimagetool. On modern distros, the bundled `strip`
 * binary can fail on newer ELF sections (for example `.relr.dyn`) which can abort the linuxdeploy
 * plugin execution. For dev/preview lanes, prefer reliable builds over marginal size savings.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveLinuxTauriBundlerEnvOverrides(env = process.env) {
  return {
    // AppImage tooling is frequently the flakiest part of Linux packaging on CI runners.
    // Ensure we get actionable backtraces in logs when linuxdeploy/AppImageKit fails.
    APPIMAGE_EXTRACT_AND_RUN: env.APPIMAGE_EXTRACT_AND_RUN ?? '1',

    // Disable stripping to avoid failures from older AppImageKit/tooling when encountering
    // newer ELF metadata/sections. Size impact is acceptable for rolling dev builds.
    NO_STRIP: env.NO_STRIP ?? '1',

    RUST_BACKTRACE: env.RUST_BACKTRACE ?? '1',
    RUST_LOG: env.RUST_LOG ?? 'tauri_bundler=debug',
  };
}

/**
 * linuxdeploy (via Tauri's AppImage bundling) can fail when it tries to run `ldd` on our bundled
 * `hsetup` sidecar binary. On Linux, we don't need `hsetup` to be an `externalBin` in `usr/bin`:
 * the Tauri runtime can resolve and execute it from the app's resource directory.
 *
 * Bundling it as a resource avoids linuxdeploy attempting to patch/scan the binary during AppImage creation.
 *
 * @returns {{ bundle: { externalBin: string[]; resources: string[] } }}
 */
export function resolveLinuxHsetupResourcesOverrideConfig() {
  return {
    bundle: {
      // Remove externalBin so Tauri does not place hsetup into AppDir/usr/bin.
      externalBin: [],
      // Include the target-suffixed sidecar produced by `build.rs` as a normal bundle resource instead.
      resources: ['binaries/hsetup-*'],
    },
  };
}

/**
 * @param {{ environment: string }} opts
 * @returns {{
 *   productName: string;
 *   appRelativePath: string;
 *   legacyHsetupRelativePath: string;
 *   resourceHsetupDirRelativePath: string;
 *   resourceHsetupPrefix: string;
 * }}
 */
export function resolveLinuxAppImageDiagnosticsLayout(opts) {
  const environment = String(opts.environment ?? '').trim();
  const productName = resolveLinuxProductNameOverride({ environment }) ?? 'Happier';
  return {
    productName,
    appRelativePath: path.join('usr', 'bin', 'app'),
    legacyHsetupRelativePath: path.join('usr', 'bin', 'hsetup'),
    resourceHsetupDirRelativePath: path.join('usr', 'lib', productName, 'binaries'),
    resourceHsetupPrefix: 'hsetup-',
  };
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string>; timeoutMs?: number; stdio?: import('node:child_process').StdioOptions }} extra
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${extra.cwd}) ${printable}`);
    return;
  }

  execFileSyncPortable(cmd, args, {
    cwd: extra.cwd,
    env: { ...process.env, ...(extra.env ?? {}) },
    stdio: extra.stdio ?? 'inherit',
    timeout: extra.timeoutMs ?? 30 * 60_000,
  });
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string> }} extra
 * @returns {string}
 */
function runCapture(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${extra.cwd}) ${printable}`);
    return '';
  }

  return execFileSyncPortable(cmd, args, {
    cwd: extra.cwd,
    env: { ...process.env, ...(extra.env ?? {}) },
    stdio: 'pipe',
    timeout: 2 * 60_000,
  });
}

/**
 * Best-effort diagnostics for Linux AppImage bundling failures.
 * The linuxdeploy plugin stack can swallow ldd output; dump actionable details when bundling fails.
 *
 * @param {{ repoRoot: string; absUiDir: string; environment: string }} opts
 */
function dumpLinuxAppImageDiagnostics(opts) {
  if (process.platform !== 'linux') return;

  const repoRoot = String(opts.repoRoot ?? '').trim();
  const absUiDir = String(opts.absUiDir ?? '').trim();
  const environment = String(opts.environment ?? '').trim();

  const layout = resolveLinuxAppImageDiagnosticsLayout({ environment });
  const productName = layout.productName;
  const appDirPath = path.join(absUiDir, 'src-tauri', 'target', 'release', 'bundle', 'appimage', `${productName}.AppDir`);
  const appPath = path.join(appDirPath, layout.appRelativePath);
  const legacyHsetupPath = path.join(appDirPath, layout.legacyHsetupRelativePath);
  const resourceHsetupDirPath = path.join(appDirPath, layout.resourceHsetupDirRelativePath);

  /**
   * @param {unknown} error
   */
  function formatExecErrorOutput(error) {
    if (!error || typeof error !== 'object') return String(error);
    const stdout = /** @type {{ stdout?: unknown }} */ (error).stdout;
    const stderr = /** @type {{ stderr?: unknown }} */ (error).stderr;
    const stdoutText =
      typeof stdout === 'string'
        ? stdout
        : stdout instanceof Uint8Array
          ? Buffer.from(stdout).toString('utf8')
          : '';
    const stderrText =
      typeof stderr === 'string'
        ? stderr
        : stderr instanceof Uint8Array
          ? Buffer.from(stderr).toString('utf8')
          : '';
    const parts = [String(error)];
    if (stdoutText.trim()) parts.push(`stdout:\n${stdoutText}`);
    if (stderrText.trim()) parts.push(`stderr:\n${stderrText}`);
    return parts.join('\n');
  }

  console.log('::group::[pipeline] tauri linux diagnostics');
  try {
    if (!fs.existsSync(appDirPath)) {
      console.log(`[pipeline] AppDir not found: ${appDirPath}`);
      return;
    }

    try {
      const entries = fs.readdirSync(path.join(appDirPath, 'usr', 'bin'));
      console.log(`[pipeline] AppDir usr/bin entries: ${entries.join(', ')}`);
    } catch {
      // ignore
    }

    /** @type {string[]} */
    const candidates = [];
    if (fs.existsSync(appPath)) candidates.push(appPath);
    if (fs.existsSync(legacyHsetupPath)) candidates.push(legacyHsetupPath);

    if (fs.existsSync(resourceHsetupDirPath)) {
      try {
        const entries = fs.readdirSync(resourceHsetupDirPath).filter((name) => name.startsWith(layout.resourceHsetupPrefix));
        console.log(`[pipeline] AppDir resource hsetup entries: ${entries.join(', ') || '<none>'}`);
        for (const entry of entries) {
          candidates.push(path.join(resourceHsetupDirPath, entry));
        }
      } catch {
        // ignore
      }
    } else {
      console.log(`[pipeline] AppDir resource hsetup dir missing: ${resourceHsetupDirPath}`);
    }

    for (const candidatePath of candidates) {
      try {
        const out = execFileSyncPortable('bash', ['-lc', `ls -l ${JSON.stringify(candidatePath)}`], {
          cwd: repoRoot || process.cwd(),
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });
        process.stdout.write(`[pipeline] perms ${candidatePath}\n${out}`);
      } catch (error) {
        console.log(`[pipeline] perms failed for ${candidatePath}: ${formatExecErrorOutput(error)}`);
      }

      try {
        const out = execFileSyncPortable('file', [candidatePath], {
          cwd: repoRoot || process.cwd(),
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });
        process.stdout.write(`[pipeline] file ${candidatePath}\n${out}`);
      } catch (error) {
        console.log(`[pipeline] file failed for ${candidatePath}: ${formatExecErrorOutput(error)}`);
      }

      try {
        // Use bash so we can capture ldd stderr reliably even when it exits non-zero.
        const out = execFileSyncPortable('bash', ['-lc', `ldd ${JSON.stringify(candidatePath)} 2>&1 || true`], {
          cwd: repoRoot || process.cwd(),
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });
        process.stdout.write(`[pipeline] ldd ${candidatePath}\n${out}`);
      } catch (error) {
        console.log(`[pipeline] ldd failed for ${candidatePath}: ${formatExecErrorOutput(error)}`);
      }
    }

    try {
      for (const rel of ['usr/lib', 'usr/lib64']) {
        const dir = path.join(appDirPath, rel);
        if (!fs.existsSync(dir)) continue;
        const entries = fs
          .readdirSync(dir)
          .filter((name) => name === 'libc.so.6' || name.startsWith('ld-linux') || name.startsWith('ld-musl'));
        if (entries.length > 0) {
          console.log(`[pipeline] ${rel} glibc-ish entries: ${entries.join(', ')}`);
        }
      }
    } catch {
      // ignore
    }
  } finally {
    console.log('::endgroup::');
  }
}

/**
 * @param {string} dir
 * @param {string} filename
 */
function tempFile(dir, filename) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}

/**
 * We avoid invoking Yarn/Corepack on Windows runners because Corepack shims can fail when Git-Bash
 * provides a POSIX-style PATH (Corepack tries to spawn `yarn` during validation). Instead, we use
 * Node + npm CLI to run `tauri:prepare:build` and call the Tauri CLI directly from node_modules.
 *
 * @param {{ platform: NodeJS.Platform; nodeExecPath: string; npmExecPath?: string }} opts
 */
export function resolveTauriPrepareBuildInvocation(opts) {
  if (opts.platform !== 'win32') {
    throw new Error('resolveTauriPrepareBuildInvocation is Windows-only');
  }

  const normalized = String(opts.npmExecPath ?? '').trim();
  if (normalized) {
    return { cmd: opts.nodeExecPath, args: [normalized, 'run', '-s', 'tauri:prepare:build'] };
  }

  const nodeDir = path.win32.dirname(opts.nodeExecPath);
  const fallback = path.win32.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { cmd: opts.nodeExecPath, args: [fallback, 'run', '-s', 'tauri:prepare:build'] };
}

/**
 * @param {{ platform: NodeJS.Platform; absUiDir: string }} opts
 */
export function resolveTauriCliInvocation(opts) {
  if (opts.platform === 'win32') {
    return { cmd: path.win32.join(opts.absUiDir, 'node_modules', '.bin', 'tauri.cmd'), args: [] };
  }
  return { cmd: path.join(opts.absUiDir, 'node_modules', '.bin', 'tauri'), args: [] };
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'build-version': { type: 'string', default: '' },
      'tauri-target': { type: 'string', default: '' },
      'ui-dir': { type: 'string', default: 'apps/ui' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const requestedEnvironment = String(values.environment ?? '').trim();
  const normalizedChannel = normalizePublicReleaseChannel(requestedEnvironment);
  const environment = normalizedChannel === 'stable' ? 'production' : normalizedChannel;
  if (!environment) {
    fail(
      `--environment must be ${JSON.stringify(
        formatPublicReleaseChannelChoices({ stableAlias: 'production', preferredOrder: ['dev', 'preview', 'stable'] })
      )} (got: ${requestedEnvironment || '<empty>'})`
    );
  }

  const buildVersion = String(values['build-version'] ?? '').trim();
  if (environment !== 'production' && !buildVersion) {
    fail('--build-version is required when --environment preview or dev');
  }

  const tauriTarget = String(values['tauri-target'] ?? '').trim();
  const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const absUiDir = path.resolve(repoRoot, uiDir);
  if (!fs.existsSync(absUiDir)) {
    fail(`ui dir not found: ${uiDir}`);
  }

  const tmpRoot = String(process.env.RUNNER_TEMP ?? '').trim() || os.tmpdir();

  if (tauriTarget) {
    run(opts, 'rustup', ['target', 'add', tauriTarget], { cwd: absUiDir, timeoutMs: 10 * 60_000 });
  }

  const platform = process.platform;
  const yarn = platform === 'win32' ? null : resolveYarnInvocation();
  const targetArgs = tauriTarget ? ['--target', tauriTarget] : [];
  /** @type {string[]} */
  const configs = [];

  const linuxProductNameOverride = resolveLinuxProductNameOverride({ environment });
  if (platform === 'linux' && linuxProductNameOverride) {
    const linuxProductNameOverridePath = tempFile(tmpRoot, 'tauri.linux.productName.override.json');
    if (opts.dryRun) {
      console.log(`[dry-run] write ${linuxProductNameOverridePath} (productName=${linuxProductNameOverride})`);
    } else {
      fs.writeFileSync(
        linuxProductNameOverridePath,
        `${JSON.stringify({ productName: linuxProductNameOverride })}\n`,
        'utf8',
      );
    }
    configs.push('--config', linuxProductNameOverridePath);
  }

  if (platform === 'linux') {
    const linuxHsetupOverridePath = tempFile(tmpRoot, 'tauri.linux.hsetup.resources.override.json');
    if (opts.dryRun) {
      console.log(`[dry-run] write ${linuxHsetupOverridePath} (bundle hsetup as resource)`);
    } else {
      fs.writeFileSync(
        linuxHsetupOverridePath,
        `${JSON.stringify(resolveLinuxHsetupResourcesOverrideConfig())}\n`,
        'utf8',
      );
    }
    configs.push('--config', linuxHsetupOverridePath);
  }

  const signingKeyValue = String(process.env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim();
  const signingKeyPassword = resolveTauriSigningPrivateKeyPassword(process.env);
  const signingKeyPath = signingKeyValue
    ? ensureTauriSigningKeyFile({ tmpRoot, keyValue: signingKeyValue, dryRun: opts.dryRun })
    : '';
  if (signingKeyPath) {
    const updaterOverridePath = tempFile(tmpRoot, 'tauri.updater.override.json');
    if (opts.dryRun) {
      console.log(`[dry-run] write ${updaterOverridePath} (enable updater artifacts)`);
    } else {
      const payload = { bundle: { createUpdaterArtifacts: true } };
      fs.writeFileSync(updaterOverridePath, `${JSON.stringify(payload)}\n`, 'utf8');
    }
    configs.push('--config', updaterOverridePath);
  }

  // Tauri `beforeBuildCommand` uses Corepack internally (`corepack yarn -s tauri:prepare:build`) which
  // has proven flaky on Windows runners (Corepack tries to spawn `yarn` and fails). We avoid that
  // by running the frontend build ourselves and overriding the hook to a fast no-op.
  const beforeBuildOverridePath = tempFile(tmpRoot, 'tauri.beforeBuild.override.json');
  if (opts.dryRun) {
    console.log(`[dry-run] write ${beforeBuildOverridePath} (disable beforeBuildCommand; already built)`);
  } else {
    const payload = { build: { beforeBuildCommand: 'node -p 1' } };
    fs.writeFileSync(beforeBuildOverridePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }
  configs.push('--config', beforeBuildOverridePath);

  const appleSigningIdentity = String(process.env.APPLE_SIGNING_IDENTITY ?? '').trim();
  if (process.platform === 'darwin' && appleSigningIdentity) {
    const codesignOverride = tempFile(tmpRoot, 'tauri.codesign.override.json');
    if (opts.dryRun) {
      console.log(`[dry-run] write ${codesignOverride} (macOS signingIdentity=${appleSigningIdentity})`);
    } else {
      const payload = { bundle: { macOS: { signingIdentity: appleSigningIdentity, hardenedRuntime: true } } };
      fs.writeFileSync(codesignOverride, `${JSON.stringify(payload)}\n`, 'utf8');
    }
    configs.push('--config', codesignOverride);
  }

  const baseTauriEnv = {
    CI: 'true',
    APP_ENV: environment,
    ...(process.platform === 'linux' ? resolveLinuxTauriBundlerEnvOverrides(process.env) : {}),
    ...(signingKeyPath ? { TAURI_SIGNING_PRIVATE_KEY: signingKeyPath } : {}),
    ...(signingKeyPassword ? { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingKeyPassword } : {}),
  };

  // Build the frontend assets once, outside of Tauri's internal beforeBuild hook.
  if (platform === 'win32') {
    const npm = resolveTauriPrepareBuildInvocation({
      platform,
      nodeExecPath: process.execPath,
      npmExecPath: process.env.npm_execpath,
    });
    run(opts, npm.cmd, npm.args, { cwd: absUiDir, env: baseTauriEnv });
  } else {
    run(opts, yarn.cmd, [...yarn.prefixArgs, '-s', 'tauri:prepare:build'], { cwd: absUiDir, env: baseTauriEnv });
  }

  if (platform === 'linux' && shouldRunLinuxHsetupLddPreflight()) {
    const hsetupPath = path.join(repoRoot, 'apps', 'bootstrap', 'dist', 'bin', 'hsetup');
    try {
      console.log(`[pipeline] tauri linux preflight: file ${hsetupPath}`);
      const fileOut = runCapture(opts, 'file', [hsetupPath], { cwd: repoRoot });
      if (fileOut) process.stdout.write(fileOut);
      console.log(`[pipeline] tauri linux preflight: ldd ${hsetupPath}`);
      const lddOut = runCapture(opts, 'ldd', [hsetupPath], { cwd: repoRoot });
      if (lddOut) process.stdout.write(lddOut);
    } catch (error) {
      console.error('[pipeline] tauri linux preflight failed: hsetup ldd did not succeed.');
      throw error;
    }
  }

  if (environment !== 'production') {
    const tauriBuildVersion = platform === 'win32'
      ? normalizeTauriBuildVersionForWindows(buildVersion)
      : buildVersion;
    const versionOverride = tempFile(tmpRoot, 'tauri.version.override.json');
    if (opts.dryRun) {
      console.log(`[dry-run] write ${versionOverride} (version=${tauriBuildVersion})`);
    } else {
      fs.writeFileSync(versionOverride, `${JSON.stringify({ version: tauriBuildVersion })}\n`, 'utf8');
    }

    const configPath = environment === 'publicdev' ? 'src-tauri/tauri.publicdev.conf.json' : 'src-tauri/tauri.preview.conf.json';

    if (platform === 'win32') {
      const tauri = resolveTauriCliInvocation({ platform, absUiDir });
      run(opts, tauri.cmd, ['build', '-v', '--config', configPath, '--config', versionOverride, ...configs, ...targetArgs], {
        cwd: absUiDir,
        env: baseTauriEnv,
      });
    } else {
      try {
        run(
          opts,
          yarn.cmd,
          [...yarn.prefixArgs, 'tauri', 'build', '-v', '--config', configPath, '--config', versionOverride, ...configs, ...targetArgs],
          {
            cwd: absUiDir,
            env: baseTauriEnv,
          },
        );
      } catch (error) {
        dumpLinuxAppImageDiagnostics({ repoRoot, absUiDir, environment });
        throw error;
      }
    }
    return;
  }

  if (platform === 'win32') {
    const tauri = resolveTauriCliInvocation({ platform, absUiDir });
    run(opts, tauri.cmd, ['build', '-v', ...configs, ...targetArgs], {
      cwd: absUiDir,
      env: baseTauriEnv,
    });
    return;
  }

  run(opts, yarn.cmd, [...yarn.prefixArgs, 'tauri', 'build', '-v', ...configs, ...targetArgs], {
    cwd: absUiDir,
    env: baseTauriEnv,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath === selfPath) {
  main();
}
