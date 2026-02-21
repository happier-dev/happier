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
  if (!profile) fail('--profile is required (full|fast|none|custom)');
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
}

main();

