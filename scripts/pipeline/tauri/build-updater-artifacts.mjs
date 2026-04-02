// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ensureTauriSigningKeyFile } from './ensure-signing-key-file.mjs';
import { resolveTauriSigningPrivateKeyPassword } from './resolve-signing-key-password.mjs';
import { resolveYarnInvocation } from './resolve-yarn-invocation.mjs';
import { formatPublicReleaseChannelChoices, normalizePublicReleaseChannel } from '../release/lib/public-release-rings.mjs';
import { execFileSyncPortable } from '../lib/exec-file-sync-portable.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
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
 * @param {string} dir
 * @param {string} filename
 */
function tempFile(dir, filename) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
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

  const yarn = resolveYarnInvocation();
  const targetArgs = tauriTarget ? ['--target', tauriTarget] : [];
  /** @type {string[]} */
  const configs = [];

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
    ...(process.platform === 'linux' ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
    ...(signingKeyPath ? { TAURI_SIGNING_PRIVATE_KEY: signingKeyPath } : {}),
    ...(signingKeyPassword ? { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingKeyPassword } : {}),
  };

  // Build the frontend assets once, outside of Tauri's internal beforeBuild hook.
  run(opts, yarn.cmd, [...yarn.prefixArgs, '-s', 'tauri:prepare:build'], { cwd: absUiDir, env: baseTauriEnv });

  if (environment !== 'production') {
    const versionOverride = tempFile(tmpRoot, 'tauri.version.override.json');
    if (opts.dryRun) {
      console.log(`[dry-run] write ${versionOverride} (version=${buildVersion})`);
    } else {
      fs.writeFileSync(versionOverride, `${JSON.stringify({ version: buildVersion })}\n`, 'utf8');
    }

    const configPath = environment === 'publicdev' ? 'src-tauri/tauri.publicdev.conf.json' : 'src-tauri/tauri.preview.conf.json';

    run(
      opts,
      yarn.cmd,
      [...yarn.prefixArgs, 'tauri', 'build', '--config', configPath, '--config', versionOverride, ...configs, ...targetArgs],
      {
        cwd: absUiDir,
        env: baseTauriEnv,
      },
    );
    return;
  }

  run(opts, yarn.cmd, [...yarn.prefixArgs, 'tauri', 'build', ...configs, ...targetArgs], {
    cwd: absUiDir,
    env: baseTauriEnv,
  });
}

main();
