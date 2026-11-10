import './utils/env/env.mjs';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { runForegroundChild } from './utils/execution_host/foreground_child.mjs';

const TOOL_SCRIPTS = {
  'setup-pr': 'scripts/setup_pr.mjs',
  setuppr: 'scripts/setup_pr.mjs',
  setupPR: 'scripts/setup_pr.mjs',

  'review-pr': 'scripts/review_pr.mjs',
  reviewpr: 'scripts/review_pr.mjs',
  reviewPR: 'scripts/review_pr.mjs',

  import: 'scripts/import.mjs',
  review: 'scripts/review.mjs',
  edison: 'scripts/edison.mjs',
  bench: 'scripts/bench.mjs',
  'managed-lima': 'scripts/managed_lima.mjs',
  'iroh-relay': 'scripts/iroh_relay.mjs',
  'load-sentinel': 'scripts/load_sentinel.mjs',
};

async function runTool(rootDir, scriptRel, forwarded) {
  const result = await runForegroundChild({ command: process.execPath,
    args: [join(rootDir, scriptRel), ...forwarded],
    options: { cwd: rootDir, env: process.env, stdio: 'inherit' } });
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = (positionals[0] ?? '').trim();

  const scriptRel = TOOL_SCRIPTS[cmd];

  // If the user asked for help for a specific tool, delegate to that tool's script.
  if (wantsHelp(argv, { flags }) && scriptRel && cmd && cmd !== 'help') {
    const idx = argv.indexOf(cmd);
    const forwarded = idx === -1 ? argv.slice(1) : [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    await runTool(rootDir, scriptRel, forwarded);
    return;
  }

  if (wantsHelp(argv, { flags }) || !cmd || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['setup-pr', 'review-pr', 'import', 'review', 'edison', 'bench', 'managed-lima', 'iroh-relay', 'load-sentinel'] },
      text: [
        '[tools] usage:',
        '  hstack tools setup-pr --repo=<pr-url|number> [--dev|--start] [--json] [-- ...]',
        '  hstack tools review-pr --repo=<pr-url|number> [--dev|--start] [--json] [-- ...]',
        '  hstack tools import [--json]',
        '  hstack tools review [ui|cli|server|all] [--json]',
        '  hstack tools edison [--stack=<name>] -- <edison args...>',
        '  hstack tools bench catalog | run [--concurrency=1] [--workload=ID | -- COMMAND [ARG...]]',
        '  hstack tools managed-lima setup|status|doctor|start|stop|shell|ssh-config --instance=NAME [--profile=balanced] [--json]',
        '  hstack tools iroh-relay install|status|stop [--json]',
        '  hstack tools load-sentinel --board=<handoff-board-path>',
      ].join('\n'),
    });
    return;
  }

  if (!scriptRel) {
    throw new Error(`[tools] unknown tool: ${cmd}`);
  }

  const idx = argv.indexOf(cmd);
  const forwarded = idx === -1 ? argv.slice(1) : [...argv.slice(0, idx), ...argv.slice(idx + 1)];
  await runTool(rootDir, scriptRel, forwarded);
}

main().catch((err) => {
  console.error('[tools] failed:', err);
  process.exit(1);
});
