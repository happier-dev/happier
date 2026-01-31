import './utils/env/env.mjs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getComponentRepoDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled, requireDir } from './utils/proc/pm.mjs';
import { run, runCaptureResult } from './utils/proc/proc.mjs';

/**
 * Thin wrapper around EAS CLI that:
 * - runs under Happy Stacks env (stack wrapper sets HAPPY_STACKS_ENV_FILE)
 * - ensures the Happy monorepo deps are installed (so app.config.js can be evaluated)
 * - runs EAS from packages/happy-app (the mobile app)
 *
 * Notes:
 * - We intentionally use `npx --yes eas-cli@latest` to avoid interactive "Ok to proceed? (y)" prompts.
 * - Cloud builds will only see env vars that EAS knows about (eas.json env, EAS project vars).
 */

function normalizePlatform(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return 'ios';
  if (v === 'ios' || v === 'android' || v === 'all') return v;
  return 'ios';
}

function getNpxRunner() {
  // In stack mode, the environment may not include the user's interactive shell PATH,
  // so spawning "npx" by name can fail with ENOENT even though Node is present.
  //
  // Additionally, the nvm "npx" shim is a script with a shebang (#!/usr/bin/env node).
  // Some sanitized environments can cause that to fail at exec time. To make this robust,
  // prefer invoking the npx CLI JS file directly via the current Node executable.
  const binDir = dirname(process.execPath);

  // Typical nvm/npm layout:
  //   <prefix>/bin/node
  //   <prefix>/lib/node_modules/npm/bin/npx-cli.js
  const npxCliPath = join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (existsSync(npxCliPath)) {
    return { cmd: process.execPath, prefixArgs: [npxCliPath] };
  }

  // Fallbacks (best-effort).
  const npxBins = [join(binDir, 'npx'), join(binDir, 'npx.cmd'), join(binDir, 'npx.ps1')];
  for (const p of npxBins) {
    if (existsSync(p)) return { cmd: p, prefixArgs: [] };
  }

  return { cmd: 'npx', prefixArgs: [] };
}

function normalizeEasEnvironment(raw) {
  const v = String(raw ?? '').trim();
  return v || 'production';
}

function normalizeCsvList(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildExpoEnvSyncValues(env) {
  const out = new Map();

  const keys = [
    'EXPO_EAS_PROJECT_ID',
    'EXPO_UPDATES_URL',
    'EXPO_UPDATES_CHANNEL',
    'EXPO_APP_OWNER',
    'EXPO_APP_SLUG',
    'EXPO_APP_NAME',
    'EXPO_APP_BUNDLE_ID',
    'EXPO_APP_SCHEME',
    'EXPO_APP_LINK_HOST',
    'EXPO_IOS_ASSOCIATED_DOMAINS',
    'EXPO_ANDROID_GOOGLE_SERVICES_FILE',
    'EXPO_IOS_GOOGLE_SERVICES_FILE',
  ];

  for (const k of keys) {
    const v = String(env?.[k] ?? '').trim();
    if (v) out.set(k, v);
  }

  // Small convenience: if the user set EXPO_EAS_PROJECT_ID but not EXPO_UPDATES_URL,
  // default updates URL to u.expo.dev/<projectId>.
  const pid = String(env?.EXPO_EAS_PROJECT_ID ?? '').trim();
  const url = String(env?.EXPO_UPDATES_URL ?? '').trim();
  if (pid && !url) {
    out.set('EXPO_UPDATES_URL', `https://u.expo.dev/${pid}`);
  }

  // Normalize CSV vars to the format expected by app.config.js (comma-separated).
  if (out.has('EXPO_IOS_ASSOCIATED_DOMAINS')) {
    out.set('EXPO_IOS_ASSOCIATED_DOMAINS', normalizeCsvList(out.get('EXPO_IOS_ASSOCIATED_DOMAINS')).join(','));
  }

  return out;
}

function truncateValueForDisplay(raw, { maxLen = 160 } = {}) {
  const v = String(raw ?? '');
  if (v.length <= maxLen) return v;
  return `${v.slice(0, maxLen)}…`;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const helpText = [
    '[eas] usage:',
    '  happys eas <subcommand> [--json] [-- <args...>]',
    '  happys eas build [--platform=ios|android|all] [--profile=production] [--local] [--wait|--no-wait] [--non-interactive|--interactive] [--json] [-- <extra eas args...>]',
    '  happys eas ios [--profile=production] [--local] [--wait|--no-wait] [--non-interactive|--interactive] [--json] [-- <extra eas build args...>]',
    '  happys eas android [--profile=production] [--local] [--wait|--no-wait] [--non-interactive|--interactive] [--json] [-- <extra eas build args...>]',
    '  happys eas env:sync [--environment=production|preview|development] [--dry-run] [--hide-values] [--visibility=plaintext|sensitive|secret] [--scope=project|account] [--json]',
    '',
    'examples:',
    '  happys stack eas happier build --platform ios --profile production',
    '  happys stack eas happier build --platform ios --profile production --local',
    '  happys stack eas happier ios --profile production',
    '  happys stack eas happier whoami',
    '  happys stack eas happier login',
    '  happys stack eas happier project:init',
    '  happys stack eas happier project:info -- --json',
    '  happys stack eas happier env:sync --environment production',
    '',
    'notes:',
    '- `happys stack eas <name> ...` automatically loads that stack env.',
    '- For cloud builds, consider setting EXPO_EAS_PROJECT_ID / EXPO_UPDATES_URL in EAS project env too.',
  ].join('\n');

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'happys eas <subcommand> [--json] [-- <args...>]',
      },
      text: helpText,
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const subcmd = (positionals[0] ?? '').trim() || 'help';

  if (subcmd === 'help') {
    printResult({ json, data: { usage: 'happys eas build|help' }, text: helpText });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const happyAppDir = getComponentDir(rootDir, 'happy');
  const happyRepoDir = getComponentRepoDir(rootDir, 'happy');
  await requireDir('happy', happyRepoDir);

  // Ensure repo deps exist so app.config.js can be evaluated (plugins import @expo/config-plugins, etc).
  await ensureDepsInstalled(happyRepoDir, 'happy');

  // Passthrough args after "--" (for any subcommand).
  const sepIdx = argv.indexOf('--');
  const extra = sepIdx === -1 ? [] : argv.slice(sepIdx + 1);

  // Convenience aliases.
  const isBuildAlias = subcmd === 'ios' || subcmd === 'android';
  const effectiveSubcmd = isBuildAlias ? 'build' : subcmd;
  const aliasPlatform = subcmd === 'ios' ? 'ios' : subcmd === 'android' ? 'android' : '';
  const { cmd: npxCmd, prefixArgs: npxPrefixArgs } = getNpxRunner();

  async function easCapture(args, { cwd } = {}) {
    return await runCaptureResult(
      npxCmd,
      [...npxPrefixArgs, '--yes', 'eas-cli@latest', ...args],
      { cwd: cwd ?? happyAppDir, env: process.env }
    );
  }

  async function easRun(args, { cwd } = {}) {
    await run(npxCmd, [...npxPrefixArgs, '--yes', 'eas-cli@latest', ...args], {
      cwd: cwd ?? happyAppDir,
      env: process.env,
      stdio: 'inherit',
    });
  }

  if (effectiveSubcmd === 'env:sync') {
    const environment = normalizeEasEnvironment(kv.get('--environment') ?? kv.get('--env'));
    const visibilityRaw = String(kv.get('--visibility') ?? '').trim();
    const visibility = visibilityRaw || 'plaintext';
    const scopeRaw = String(kv.get('--scope') ?? '').trim();
    const scope = scopeRaw || 'project';
    const dryRun = flags.has('--dry-run');
    const showValues = !flags.has('--hide-values');

    const values = buildExpoEnvSyncValues(process.env);
    if (values.size === 0) {
      const msg =
        `[eas] env:sync: no EXPO_* values found in the current environment.\n` +
        `Set EXPO_EAS_PROJECT_ID / EXPO_UPDATES_URL / EXPO_APP_* in your stack env, then re-run.`;
      printResult({ json, data: { ok: false, reason: 'no_values' }, text: msg });
      return;
    }

    const results = [];
    for (const [name, value] of values.entries()) {
      if (dryRun) {
        results.push({
          name,
          action: 'dry-run',
          ok: true,
          ...(showValues ? { value: truncateValueForDisplay(value) } : {}),
        });
        continue;
      }

      // Prefer update (idempotent-ish), then fall back to create.
      const update = await easCapture([
        'env:update',
        '--environment',
        environment,
        '--variable-name',
        name,
        '--value',
        value,
        '--visibility',
        visibility,
        '--scope',
        scope,
        '--non-interactive',
      ]);
      if (update.ok) {
        results.push({ name, action: 'updated', ok: true });
        continue;
      }

      const create = await easCapture([
        'env:create',
        '--environment',
        environment,
        '--name',
        name,
        '--value',
        value,
        '--type',
        'string',
        '--visibility',
        visibility,
        '--scope',
        scope,
        '--non-interactive',
      ]);
      if (create.ok) {
        results.push({ name, action: 'created', ok: true });
        continue;
      }

      results.push({
        name,
        action: 'failed',
        ok: false,
        updateErr: update.err?.trim?.() ?? String(update.err ?? ''),
        createErr: create.err?.trim?.() ?? String(create.err ?? ''),
      });

      // Fail fast on the first failure (likely auth/permissions).
      const details = [
        `[eas] env:sync failed for ${name} (environment=${environment})`,
        update.err ? `- env:update: ${String(update.err).trim()}` : '- env:update: (no stderr captured)',
        create.err ? `- env:create: ${String(create.err).trim()}` : '- env:create: (no stderr captured)',
      ].join('\n');
      throw new Error(details);
    }

    const ok = results.every((r) => r.ok);
    printResult({
      json,
      data: { ok, environment, results },
      text:
        `[eas] env:sync ${ok ? 'ok' : 'failed'} (environment=${environment})\n` +
        results
          .map((r) => {
            const suffix =
              r.action === 'dry-run' && showValues && typeof r.value === 'string' ? ` = ${r.value}` : '';
            return `- ${r.name}: ${r.action}${suffix}`;
          })
          .join('\n'),
    });
    return;
  }

  // Non-build subcommands (login/whoami/project:init/etc): forward directly.
  if (effectiveSubcmd !== 'build') {
    // Forward everything after the first positional token, excluding "--" and its args (we append those as `extra`).
    const afterSubcmd = argv.slice(argv.indexOf(subcmd) + 1);
    const trimmed = sepIdx === -1 ? afterSubcmd : afterSubcmd.slice(0, afterSubcmd.indexOf('--'));
    await easRun([subcmd, ...trimmed, ...extra]);
    return;
  }

  const platform = isBuildAlias ? aliasPlatform : normalizePlatform(kv.get('--platform'));
  const profile = String(kv.get('--profile') ?? 'production').trim() || 'production';
  const local = flags.has('--local');
  const wait = flags.has('--wait');
  const noWait = flags.has('--no-wait') || !wait;
  // Default to interactive when we have a TTY (so first-time credentials setup works),
  // but allow forcing either mode explicitly.
  const nonInteractive =
    flags.has('--non-interactive') ? true : flags.has('--interactive') ? false : !Boolean(process.stdin.isTTY);

  const baseArgs = ['build', '--profile', profile];
  if (platform) baseArgs.push('--platform', platform);
  if (local) baseArgs.push('--local');
  if (noWait) baseArgs.push('--no-wait');
  if (nonInteractive) baseArgs.push('--non-interactive');
  baseArgs.push(...extra);

  await easRun(baseArgs);
}

main().catch((err) => {
  console.error('[eas] failed:', err?.message ?? err);
  process.exit(1);
});

