import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { resolveUserConfigEnvPath } from './utils/env/config.mjs';
import { isTty, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { bold, cyan, dim, green } from './utils/ui/ansi.mjs';

const FLAVORS = [
  { label: `happier-server-light (${green('recommended')}) — simplest local install (serves UI)`, value: 'happier-server-light' },
  { label: `happier-server — full server (Docker-managed infra)`, value: 'happier-server' },
];

function normalizeFlavor(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'light' || v === 'server-light' || v === 'happier-server-light' || v === 'happy-server-light') return 'happier-server-light';
  if (v === 'server' || v === 'full' || v === 'happier-server' || v === 'happy-server') return 'happier-server';
  return raw.trim();
}

async function cmdUse({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const flavorRaw = positionals[1] ?? '';
  const flavor = normalizeFlavor(flavorRaw);
  if (!flavor) {
    throw new Error('[server-flavor] usage: hstack srv use <happier-server-light|happier-server> [--json]');
  }
  if (!['happier-server-light', 'happier-server'].includes(flavor)) {
    throw new Error(`[server-flavor] unknown flavor: ${flavor}`);
  }

  const envPath = resolveUserConfigEnvPath({ cliRootDir: rootDir });
  await ensureEnvFileUpdated({
    envPath,
    updates: [
      { key: 'HAPPIER_STACK_SERVER_COMPONENT', value: flavor },
    ],
  });

  const json = wantsJson(argv, { flags });
  printResult({
    json,
    data: { ok: true, flavor },
    text: `[server-flavor] set HAPPIER_STACK_SERVER_COMPONENT=${flavor} (saved to ${envPath})`,
  });
}

async function cmdUseInteractive({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  await withRl(async (rl) => {
    const flavor = await promptSelect(rl, {
      title: `${bold('Server flavor')}\n${dim('Pick the backend you want to run by default. You can change per-stack too.')}`,
      options: FLAVORS,
      defaultIndex: 0,
    });
    const envPath = resolveUserConfigEnvPath({ cliRootDir: rootDir });
    await ensureEnvFileUpdated({
      envPath,
      updates: [
        { key: 'HAPPIER_STACK_SERVER_COMPONENT', value: flavor },
      ],
    });
    printResult({
      json,
      data: { ok: true, flavor },
      text: `[server-flavor] set HAPPIER_STACK_SERVER_COMPONENT=${flavor} (saved to ${envPath})`,
    });
  });
}

async function cmdStatus({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const flavor = process.env.HAPPIER_STACK_SERVER_COMPONENT?.trim() || 'happier-server-light';
  printResult({ json, data: { flavor }, text: `[server-flavor] current: ${flavor}` });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags } = parseArgs(helpScopeArgv);
  const positionals = helpScopeArgv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const cmd = positionals[0] ?? 'help';
  const json = wantsJson(helpScopeArgv, { flags });

  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const usageByCmd = new Map([
    ['status', 'hstack srv status [--json]'],
    ['use', 'hstack srv use <happier-server-light|happier-server> [--json]'],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const usage = usageByCmd.get(cmd);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd, usage },
        text: [`[server-flavor ${cmd}] usage:`, `  ${usage}`, '', 'see also:', '  hstack srv --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'use'] },
      text: [
        '[server-flavor] usage:',
        '  hstack srv status [--json]',
        '  hstack srv use <happier-server-light|happier-server> [--json]',
        '  hstack srv use --interactive [--json]',
        '',
        'notes:',
        '  - This sets the default server flavor for future stack runs.',
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'status') {
    await cmdStatus({ argv });
    return;
  }
  if (cmd === 'use') {
    const interactive = argv.includes('--interactive') || argv.includes('-i');
    if (interactive && isTty()) {
      await cmdUseInteractive({ rootDir, argv });
    } else {
      await cmdUse({ rootDir, argv });
    }
    return;
  }

  throw new Error(`[server-flavor] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[server-flavor] failed:', err);
  process.exit(1);
});
