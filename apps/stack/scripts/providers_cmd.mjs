import './utils/env/env.mjs';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { createStepPrinter } from './utils/cli/progress.mjs';
import { installAgentCli } from '@happier-dev/cli-common/agents';
import {
  assertKnownStackProviderIds,
  resolveStackProviderIds,
  resolveStackProviderInstallLabel,
  resolveStackProviderPlatform,
  resolveStackProviderRows,
} from './providers_registry.mjs';

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

async function cmdList({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const platform = resolveStackProviderPlatform();
  const rows = resolveStackProviderRows();

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
    ...resolveStackProviderIds(inputFromFlag),
    ...inputFromPositional.flatMap((s) => resolveStackProviderIds(String(s).trim())),
  ];

  if (wanted.length === 0) {
    throw new Error('[providers] missing providers. Use --providers=claude,codex or pass ids as positionals.');
  }

  assertKnownStackProviderIds(wanted);
  const resolved = wanted;

  const platform = resolveStackProviderPlatform();
  if (platform === 'unsupported') {
    throw new Error('[providers] unsupported platform');
  }

  // In json mode, preserve the existing structured behavior (no progress output).
  if (json) {
    const results = await Promise.all(
      resolved.map((providerId) => installAgentCli({ agentId: providerId, platform, dryRun, skipIfInstalled, env: process.env })),
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
      text: null,
    });
    return;
  }

  // Human-friendly progress output (TTY spinner when interactive; simple lines otherwise).
  const steps = createStepPrinter({ enabled: true });
  const results = [];
  for (const providerId of resolved) {
    const label = resolveStackProviderInstallLabel(providerId);

    steps.start(label);
    const result = await installAgentCli({ agentId: providerId, platform, dryRun, skipIfInstalled, env: process.env });
    if (!result.ok) {
      steps.stop('x', label);
      const extra = result.logPath ? `\nlog: ${result.logPath}` : '';
      throw new Error(`[providers] install failed: ${result.errorMessage}${extra}`.trim());
    }
    if (result.alreadyInstalled) {
      steps.stop('✓', `${label} (already installed)`);
    } else if (dryRun) {
      steps.stop('✓', `${label} (dry-run)`);
    } else {
      steps.stop('✓', label);
    }
    results.push({ ok: true, providerId, alreadyInstalled: result.alreadyInstalled, logPath: result.logPath, plan: result.plan });
  }

  printResult({
    json,
    data: {
      ok: true,
      providers: resolved,
      dryRun,
      skipIfInstalled,
      plan: results.map((r) => r.plan),
      results: results.map((r) => ({ ok: true, providerId: r.providerId, alreadyInstalled: r.alreadyInstalled, logPath: r.logPath })),
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
