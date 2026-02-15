import './utils/env/env.mjs';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { AGENT_IDS, getProviderCliInstallSpec } from '@happier-dev/agents';
import { installProviderCli, planProviderCliInstall, resolvePlatformFromNodePlatform } from '@happier-dev/cli-common/providers';

function usageText() {
  return [
    '[providers] usage:',
    '  hstack providers list [--json]',
    '  hstack providers install --providers=<id1,id2> [--dry-run] [--force] [--json]',
    '  hstack providers install <id1> <id2> [--dry-run] [--force] [--json]',
    '',
    'notes:',
    '  - Provider CLIs are external binaries used by Happier backends (claude/codex/gemini/etc).',
    '  - This command installs provider CLIs (best-effort). Some providers require manual installation.',
    '  - Claude install uses the upstream native installer by default (not npm).',
    '  - Use --force to re-run the installer even if the binary is already present on PATH.',
  ].join('\n');
}

function splitProviders(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function resolvePlatform() {
  return resolvePlatformFromNodePlatform(process.platform) ?? 'unsupported';
}

function planForProvider(providerId) {
  const platform = resolvePlatform();
  if (platform === 'unsupported') {
    return { ok: false, provider: providerId, error: 'Unsupported platform' };
  }
  const planned = planProviderCliInstall({ providerId, platform });
  if (!planned.ok) {
    return { ok: false, provider: providerId, error: planned.errorMessage };
  }
  return { ok: true, provider: providerId, commands: planned.plan.commands };
}

async function cmdList({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const platform = resolvePlatform();
  const rows = AGENT_IDS.map((id) => {
    const spec = getProviderCliInstallSpec(id);
    const planned = planForProvider(id);
    return {
      id: spec.id,
      title: spec.title,
      binaries: spec.binaries,
      autoInstall: planned.ok,
      note: planned.ok ? null : planned.error,
      platform,
    };
  });

  printResult({
    json,
    data: { ok: true, platform, providers: rows },
    text: json
      ? null
      : rows
          .map((r) => `${r.autoInstall ? '✓' : '-'} ${r.id}${r.title ? `  (${r.title})` : ''}${r.note ? ` — ${r.note}` : ''}`)
          .join('\n'),
  });
}

async function cmdInstall({ argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const dryRun = flags.has('--dry-run') || flags.has('--plan');
  const force = flags.has('--force') || flags.has('--reinstall');
  const skipIfInstalled = !force;

  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const inputFromFlag = kv.get('--providers') ?? '';
  const inputFromPositional = positionals;

  const wanted = [
    ...splitProviders(inputFromFlag),
    ...inputFromPositional.flatMap((s) => splitProviders(String(s).trim().toLowerCase())),
  ];

  if (wanted.length === 0) {
    throw new Error('[providers] missing providers. Use --providers=claude,codex or pass ids as positionals.');
  }

  const resolved = wanted.map((id) => {
    if (!AGENT_IDS.includes(id)) {
      const e = new Error(`[providers] unknown provider: ${id}`);
      e.code = 'EUNKNOWN_PROVIDER';
      throw e;
    }
    return id;
  });

  const platform = resolvePlatform();
  if (platform === 'unsupported') {
    throw new Error('[providers] unsupported platform');
  }

  const results = resolved.map((providerId) =>
    installProviderCli({ providerId, platform, dryRun, skipIfInstalled, env: process.env }),
  );
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    const first = failures[0];
    const extra = first.logPath ? `\nlog: ${first.logPath}` : '';
    throw new Error(`[providers] install failed: ${first.errorMessage}${extra}`.trim());
  }

  const plan = results.map((r) => (r.ok ? r.plan : null)).filter(Boolean);

  printResult({
    json,
    data: {
      ok: true,
      providers: resolved,
      dryRun,
      skipIfInstalled,
      plan,
      results: results.map((r) => (r.ok ? { ok: true, providerId: r.plan.providerId, alreadyInstalled: r.alreadyInstalled, logPath: r.logPath } : r)),
    },
    text: json ? null : `✓ providers installed: ${resolved.join(', ')}`,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (argv.length === 0 || wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usageText() }, text: usageText() });
    return;
  }

  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const sub = String(positionals[0] ?? '').trim();
  if (sub === 'list') {
    await cmdList({ argv: argv.slice(1) });
    return;
  }
  if (sub === 'install') {
    await cmdInstall({ argv: argv.slice(1) });
    return;
  }

  printResult({ json, data: { usage: usageText() }, text: usageText() });
  process.exit(2);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
