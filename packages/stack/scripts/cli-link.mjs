import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { ensureCliBuilt, ensureHappyCliLocalNpmLinked } from './utils/proc/pm.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';

/**
 * Link the local Happy CLI wrapper into your PATH.
 *
 * This is intentionally extracted so you can re-run linking without doing a full `happys bootstrap`.
 *
 * What it does:
 * - optionally builds `components/happy-cli` (controlled by env/flags)
 * - installs `happy`/`happys` shims under `<homeDir>/bin` (default: `~/.happy-stacks/bin`) (recommended over `npm link`)
 *
 * Env:
 * - HAPPY_LOCAL_CLI_BUILD=0 to skip building happy-cli
 * - HAPPY_LOCAL_NPM_LINK=0 to skip shim installation
 *
 * Flags:
 * - --no-build: skip building happy-cli
 * - --no-link: skip shim installation
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--no-build', '--no-link'], json: true },
      text: [
        '[cli-link] usage:',
        '  happys cli:link [--no-build] [--no-link] [--json]',
        '  (legacy in a cloned repo): pnpm cli:link [-- --no-build] [--json]',
        '  node scripts/cli-link.mjs [--no-build] [--no-link] [--json]',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  const buildCli = !flags.has('--no-build') && (process.env.HAPPY_LOCAL_CLI_BUILD ?? '1') !== '0';
  const npmLinkCli = !flags.has('--no-link') && (process.env.HAPPY_LOCAL_NPM_LINK ?? '1') !== '0';

  await ensureCliBuilt(cliDir, { buildCli });
  await ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli });

  printResult({ json, data: { ok: true, buildCli, npmLinkCli }, text: '[local] cli link complete' });
}

main().catch((err) => {
  console.error('[local] cli link failed:', err);
  process.exit(1);
});
