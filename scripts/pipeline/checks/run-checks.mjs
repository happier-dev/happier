// @ts-check

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { resolveChecksProfilePlan } from './lib/checks-profile.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
function commandExists(cmd) {
  try {
    const out = execFileSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1 && echo yes || echo no`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
      .trim()
      .toLowerCase();
    return out === 'yes';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} defaultValue
 */
function resolveBoolEnv(value, name, defaultValue) {
  const raw = String(value ?? '').trim();
  if (!raw) return defaultValue;
  return parseBoolString(raw, name);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} autoValue
 */
function resolveAutoBool(value, name, autoValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return autoValue;
  return parseBoolString(raw, name);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string> }} [extra]
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }
  execFileSync(cmd, args, {
    env: { ...process.env, ...(extra?.env ?? {}) },
    stdio: 'inherit',
    timeout: 4 * 60 * 60_000,
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      'custom-checks': { type: 'string', default: '' },
      'install-deps': { type: 'string', default: 'auto' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const profile = String(values.profile ?? '').trim();
  if (!profile) fail('--profile is required (full|fast|none|custom|release-assets)');
  const customChecks = String(values['custom-checks'] ?? '').trim();

  const plan = resolveChecksProfilePlan({
    // @ts-expect-error runtime validation happens in resolveChecksProfilePlan
    profile,
    customChecks,
  });

  const dryRun = values['dry-run'] === true;
  const installDeps = resolveAutoBool(values['install-deps'], '--install-deps', process.env.GITHUB_ACTIONS === 'true');

  console.log(`[pipeline] checks: profile=${profile}`);
  console.log('[pipeline] checks: plan');
  for (const [k, v] of Object.entries(plan)) {
    console.log(`- ${k}: ${v}`);
  }

  if (!plan.runCi) {
    console.log('[pipeline] checks: skipped (profile=none)');
    return;
  }

  if (installDeps) {
    if (commandExists('corepack')) {
      run({ dryRun }, 'corepack', ['enable']);
      run({ dryRun }, 'corepack', ['prepare', 'yarn@1.22.22', '--activate']);
    }
    run(
      { dryRun },
      'yarn',
      ['install', '--frozen-lockfile', '--ignore-engines'],
      { env: { YARN_PRODUCTION: 'false', npm_config_production: 'false' } },
    );
  }

  // Baseline checks (mirrors release workflow intent).
  run({ dryRun }, 'yarn', ['test']);
  run({ dryRun }, 'yarn', ['test:integration']);
  run({ dryRun }, 'yarn', ['typecheck']);

  // UI E2E (Playwright) is now part of the default preflight plan for full/fast.
  if (plan.runUiE2e) run({ dryRun }, 'yarn', ['test:e2e:ui']);

  // Release contracts are part of release checks.
  run({ dryRun }, 'yarn', ['-s', 'test:release:contracts'], { env: { HAPPIER_FEATURE_POLICY_ENV: '' } });
  run({ dryRun }, process.execPath, ['scripts/pipeline/run.mjs', 'release-sync-installers', '--check']);

  if (plan.runE2eCore) run({ dryRun }, 'yarn', ['test:e2e:core:fast']);
  if (plan.runE2eCoreSlow) run({ dryRun }, 'yarn', ['test:e2e:core:slow']);
  if (plan.runServerDbContract) run({ dryRun }, 'yarn', ['test:db-contract:docker']);
  if (plan.runStress) run({ dryRun }, 'yarn', ['test:stress']);
  if (plan.runBuildWebsite) run({ dryRun }, 'yarn', ['website:build']);
  if (plan.runBuildDocs) run({ dryRun }, 'yarn', ['docs:build']);
  if (plan.runCliSmokeLinux) run({ dryRun }, process.execPath, ['scripts/pipeline/run.mjs', 'smoke-cli']);

  if (plan.runReleaseAssetsE2e) {
    const modeRaw = String(process.env.HAPPIER_RELEASE_ASSETS_E2E_MODE ?? '').trim().toLowerCase();
    const mode = modeRaw === 'npm' || modeRaw === 'local' ? modeRaw : modeRaw ? null : 'local';
    if (!mode) {
      fail(`HAPPIER_RELEASE_ASSETS_E2E_MODE must be 'npm' or 'local' (got: ${modeRaw || '<empty>'})`);
    }

    const monorepoRaw = String(process.env.HAPPIER_RELEASE_ASSETS_E2E_MONOREPO ?? '').trim().toLowerCase();
    const monorepoDefault = mode === 'local' ? 'local' : 'github';
    const monorepo =
      monorepoRaw === 'github' || monorepoRaw === 'local' ? monorepoRaw : monorepoRaw ? null : monorepoDefault;
    if (!monorepo) {
      fail(`HAPPIER_RELEASE_ASSETS_E2E_MONOREPO must be 'github' or 'local' (got: ${monorepoRaw || '<empty>'})`);
    }

    const withRelayUpgrade = resolveBoolEnv(
      process.env.HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE,
      'HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE',
      true,
    );

    if (!dryRun) {
      if (!commandExists('docker')) {
        fail("release-assets-e2e requires Docker. Fix: start Docker Desktop (macOS) or install docker engine.");
      }
      try {
        execFileSync('docker', ['info'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 });
      } catch {
        fail('release-assets-e2e requires Docker to be running. Fix: start Docker Desktop and retry.');
      }
    }

    run({ dryRun }, 'bash', [
      'scripts/release/release-assets-e2e/run.sh',
      `--mode=${mode}`,
      `--monorepo=${monorepo}`,
      withRelayUpgrade ? '--with-relay-upgrade' : '--no-relay-upgrade',
    ]);
  }

  if (plan.runSelfHostSystemd) {
    if (!dryRun) {
      if (process.platform !== 'linux') fail(`self_host_systemd is linux-only (current: ${process.platform})`);
      if (process.arch !== 'x64') fail(`self_host_systemd requires linux-x64 (current: ${process.platform}-${process.arch})`);
      if (!commandExists('systemctl')) fail('self_host_systemd requires systemctl');
      if (!commandExists('bun')) fail('self_host_systemd requires bun (needed to build compiled binaries)');
      if (typeof process.getuid === 'function' && process.getuid() !== 0 && !commandExists('sudo')) {
        fail('self_host_systemd requires sudo/root access');
      }
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_systemd.real.integration.test.mjs']);
  }

  if (plan.runSelfHostLaunchd) {
    if (!dryRun) {
      if (process.platform !== 'darwin') fail(`self_host_launchd is macOS-only (current: ${process.platform})`);
      if (!commandExists('launchctl')) fail('self_host_launchd requires launchctl');
      if (!commandExists('bun')) fail('self_host_launchd requires bun (needed to build compiled binaries)');
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_launchd.real.integration.test.mjs']);
  }

  if (plan.runSelfHostDaemon) {
    if (!dryRun) {
      if (process.platform !== 'linux' && process.platform !== 'darwin') {
        fail(`self_host_daemon supports linux and macOS only (current: ${process.platform})`);
      }
      if (!commandExists('bun')) fail('self_host_daemon requires bun (needed to build compiled binaries)');
      if (process.platform === 'linux') {
        if (!commandExists('systemctl')) fail('self_host_daemon requires systemctl on linux');
        if (typeof process.getuid === 'function' && process.getuid() !== 0 && !commandExists('sudo')) {
          fail('self_host_daemon requires sudo/root access on linux');
        }
      }
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_daemon.real.integration.test.mjs']);
  }
}

main();
