import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { run } from './utils/proc/proc.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { banner, cmd, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, yellow } from './utils/ui/ansi.mjs';

import { buildMobileDevClientInstallInvocation } from './utils/mobile/dev_client_install_invocation.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || flags.has('--help') || argv.length === 0) {
    printResult({
      json,
      data: {
        flags: ['--device=<id-or-name>', '--port=<port>', '--clean', '--configuration=Debug|Release', '--json'],
      },
      text: [
        banner('mobile-dev-client', { subtitle: 'Install the shared iOS dev-client app (one-time).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack mobile-dev-client')} --install [--device=...] [--port=...] [--clean] [--configuration=Debug|Release] [--json]`,
        '',
        sectionTitle('notes:'),
        `- Installs a dedicated ${cyan('hstack Dev')} Expo dev-client app on your iPhone.`,
        `- This app is intended to be ${cyan('reused across stacks')} (no per-stack installs).`,
        `- Requires ${yellow('Xcode')} + ${yellow('CocoaPods')} (macOS).`,
      ].join('\n'),
    });
    return;
  }

  if (!flags.has('--install')) {
    printResult({
      json,
      data: { ok: false, error: 'missing_install_flag' },
      text: `${yellow('!')} missing ${cyan('--install')}. Run: ${cmd('hstack mobile-dev-client --help')}`,
    });
    process.exit(1);
  }

  const rootDir = getRootDir(import.meta.url);
  const invocation = buildMobileDevClientInstallInvocation({ rootDir, argv, baseEnv: process.env });

  const env = {
    ...invocation.env,
  };

  const out = await run(process.execPath, invocation.nodeArgs, { cwd: rootDir, env });
  if (json) {
    printResult({ json, data: { ok: true, installed: true, identity: invocation.identity, out } });
  }
}

main().catch((err) => {
  console.error('[mobile-dev-client] failed:', err);
  process.exit(1);
});
