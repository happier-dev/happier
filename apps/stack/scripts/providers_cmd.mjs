import './utils/env/env.mjs';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { run } from './utils/proc/proc.mjs';
import { PROVIDERS, resolveProvider } from './utils/providers/providers_registry.mjs';

function usageText() {
  return [
    '[providers] usage:',
    '  hstack providers list [--json]',
    '  hstack providers install --providers=<id1,id2> [--dry-run] [--json]',
    '  hstack providers install <id1> <id2> [--dry-run] [--json]',
    '',
    'notes:',
    '  - Provider CLIs are external binaries used by Happier backends (claude/codex/gemini/etc).',
    '  - This command installs provider CLIs (best-effort). Some providers require manual installation.',
    '  - Claude install uses the upstream native installer by default (not npm).',
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
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return 'unsupported';
}

function planForProvider(provider) {
  const platform = resolvePlatform();
  if (platform === 'unsupported') {
    return { ok: false, provider: provider.id, error: 'Unsupported platform' };
  }
  const recipe = provider.install?.[platform] ?? null;
  if (!recipe || recipe.length === 0) {
    return { ok: false, provider: provider.id, error: 'No auto-install recipe available (manual install required)' };
  }
  return { ok: true, provider: provider.id, commands: recipe };
}

async function cmdList({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const platform = resolvePlatform();
  const rows = PROVIDERS.map((p) => {
    const planned = planForProvider(p);
    return {
      id: p.id,
      title: p.title,
      binaries: p.binaries,
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
    const p = resolveProvider(id);
    if (!p) {
      const e = new Error(`[providers] unknown provider: ${id}`);
      e.code = 'EUNKNOWN_PROVIDER';
      throw e;
    }
    return p;
  });

  const plan = resolved.map((p) => planForProvider(p));
  const failures = plan.filter((p) => !p.ok);
  if (failures.length > 0) {
    const first = failures[0];
    throw new Error(`[providers] cannot auto-install ${first.provider}: ${first.error}`);
  }

  if (!dryRun) {
    for (const p of plan) {
      for (const c of p.commands) {
        await run(c.cmd, c.args, { cwd: process.cwd(), env: process.env });
      }
    }
  }

  printResult({
    json,
    data: { ok: true, providers: resolved.map((p) => p.id), dryRun, plan },
    text: json ? null : `✓ providers installed: ${resolved.map((p) => p.id).join(', ')}`,
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
