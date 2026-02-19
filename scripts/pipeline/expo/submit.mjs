// @ts-check

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; allowFailure?: boolean; timeoutMs?: number }} [extra]
 * @returns {{ ok: boolean; output: string }}
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return { ok: true, output: '' };
  }

  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...(extra?.env ?? {}) },
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: extra?.timeoutMs ?? 30 * 60_000,
    });
    return { ok: true, output: String(out ?? '') };
  } catch (err) {
    if (extra?.allowFailure) return { ok: false, output: '' };
    throw err;
  }
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      platform: { type: 'string' },
      path: { type: 'string', default: '' },
      profile: { type: 'string', default: '' },
      'eas-cli-version': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  if (!environment) fail('--environment is required');
  if (environment !== 'preview' && environment !== 'production') {
    fail(`--environment must be 'preview' or 'production' (got: ${environment})`);
  }

  const platformRaw = String(values.platform ?? '').trim();
  if (!platformRaw) fail('--platform is required');
  if (platformRaw !== 'ios' && platformRaw !== 'android' && platformRaw !== 'all') {
    fail(`--platform must be 'ios', 'android', or 'all' (got: ${platformRaw})`);
  }

  const submitPathRaw = String(values.path ?? '').trim();
  const submitProfile = String(values.profile ?? '').trim() || environment;
  if (submitPathRaw && platformRaw === 'all') {
    fail("--platform 'all' cannot be used with --path (submit per-platform with explicit paths).");
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const expoToken = String(process.env.EXPO_TOKEN ?? '').trim();
  if (!expoToken) {
    fail('EXPO_TOKEN is required for Expo submit.');
  }

  const easCliVersion =
    String(values['eas-cli-version'] ?? '').trim() || String(process.env.EAS_CLI_VERSION ?? '').trim() || '18.0.1';

  const platforms = platformRaw === 'all' ? ['ios', 'android'] : [platformRaw];
  console.log(`[pipeline] expo submit: environment=${environment} platform=${platformRaw}`);

  const submitPathAbs = submitPathRaw ? path.resolve(repoRoot, submitPathRaw) : '';
  if (submitPathAbs && !dryRun) {
    // Avoid importing fs for this script; let EAS fail with a clear message if the path is invalid.
  }

  let hadFailure = false;
  for (const platform of platforms) {
    const baseArgs = ['--yes', `eas-cli@${easCliVersion}`, 'submit', '--platform', platform];
    const submitArgs = submitPathAbs
      ? [...baseArgs, '--path', submitPathAbs, '--profile', submitProfile, '--non-interactive']
      : [...baseArgs, '--latest', '--non-interactive'];

    const appEnv = String(process.env.APP_ENV ?? '').trim() || environment;
    const result = run(opts, 'npx', submitArgs, {
      cwd: path.join(repoRoot, 'apps', 'ui'),
      env: {
        // apps/ui/app.config.js selects bundle ids by APP_ENV; ensure submit uses the same variant
        // as the intended pipeline environment unless the operator overrides it explicitly.
        APP_ENV: appEnv,
      },
      allowFailure: environment === 'preview',
    });
    if (!result.ok) {
      hadFailure = true;
      console.log(`::warning::Expo submit failed for ${platform} in preview; continuing so successful platform submissions are preserved.`);
    }
  }

  if (hadFailure) {
    process.exitCode = 0;
  }
}

main();
