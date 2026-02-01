import './utils/env/env.mjs';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { run } from './utils/proc/proc.mjs';

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
};

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = (positionals[0] ?? '').trim();

  if (wantsHelp(argv, { flags }) || !cmd || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['setup-pr', 'review-pr', 'import', 'review', 'edison'] },
      text: [
        '[tools] usage:',
        '  hapsta tools setup-pr --repo=<pr-url|number> [--dev|--start] [--json] [-- ...]',
        '  hapsta tools review-pr --repo=<pr-url|number> [--dev|--start] [--json] [-- ...]',
        '  hapsta tools import [--json]',
        '  hapsta tools review [--json]',
        '  hapsta tools edison [--stack=<name>] -- <edison args...>',
      ].join('\n'),
    });
    return;
  }

  const scriptRel = TOOL_SCRIPTS[cmd];
  if (!scriptRel) {
    throw new Error(`[tools] unknown tool: ${cmd}`);
  }

  const idx = argv.indexOf(cmd);
  const forwarded = idx === -1 ? argv.slice(1) : [...argv.slice(0, idx), ...argv.slice(idx + 1)];
  await run(process.execPath, [join(rootDir, scriptRel), ...forwarded], { cwd: rootDir, env: process.env });
}

main().catch((err) => {
  console.error('[tools] failed:', err);
  process.exit(1);
});
