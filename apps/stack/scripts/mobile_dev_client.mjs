import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { run } from './utils/proc/proc.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { join } from 'node:path';
import { banner, cmd, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, yellow } from './utils/ui/ansi.mjs';

import { defaultDevClientIdentity } from './utils/mobile/identifiers.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || flags.has('--help') || argv.length === 0) {
    printResult({
      json,
      data: {
        flags: ['--device=<id-or-name>', '--clean', '--configuration=Debug|Release', '--json'],
      },
      text: [
        banner('mobile-dev-client', { subtitle: 'Install the shared iOS dev-client app (one-time).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack mobile-dev-client')} --install [--device=...] [--clean] [--configuration=Debug|Release] [--json]`,
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
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const device = kv.get('--device') ?? '';
  const clean = flags.has('--clean');
  const configuration = kv.get('--configuration') ?? 'Debug';

  const id = defaultDevClientIdentity({ user: process.env.USER ?? process.env.USERNAME ?? 'user' });

  const args = [
    mobileScript,
    '--app-env=development',
    `--ios-app-name=${id.iosAppName}`,
    `--ios-bundle-id=${id.iosBundleId}`,
    `--scheme=${id.scheme}`,
    '--prebuild',
    ...(clean ? ['--clean'] : []),
    '--run-ios',
    `--configuration=${configuration}`,
    '--no-metro',
    ...(device ? [`--device=${device}`] : []),
  ];

  const env = {
    ...process.env,
    // Ensure Expo app config uses the dev-client scheme.
    EXPO_APP_SCHEME: id.scheme,
    // Ensure per-stack storage isolation is available during dev-client usage.
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? '',
  };

  const out = await run(process.execPath, args, { cwd: rootDir, env });
  if (json) {
    printResult({ json, data: { ok: true, installed: true, identity: id, out } });
  }
}

main().catch((err) => {
  console.error('[mobile-dev-client] failed:', err);
  process.exit(1);
});
