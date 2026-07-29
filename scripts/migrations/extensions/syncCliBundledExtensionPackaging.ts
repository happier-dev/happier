import { pathToFileURL } from 'node:url';

import {
  syncCliBundledPluginMembership,
  type BundledPluginMembershipMode,
} from './bundledPluginMembership.ts';

function parseCliArgs(argv: readonly string[]): Readonly<{ rootDir: string; mode: BundledPluginMembershipMode }> {
  let rootDir = process.cwd();
  let mode: BundledPluginMembershipMode = 'write';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--root') {
      const next = argv[index + 1];
      if (!next) throw new Error('Missing value for --root');
      rootDir = next;
      index += 1;
      continue;
    }
    if (arg === '--mode') {
      const next = argv[index + 1];
      if (next !== 'write' && next !== 'check') {
        throw new Error(`Invalid --mode (expected write|check): ${String(next)}`);
      }
      mode = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return { rootDir, mode };
}

function printUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/extensions/syncCliBundledExtensionPackaging.ts [--root DIR] [--mode write|check]',
    '',
    'Delegates apps/cli/package.json plugin dependency and bundledDependencies membership sync to bundledPluginMembership.ts.',
  ].join('\n'));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  syncCliBundledPluginMembership({
    ...parseCliArgs(argv),
    requireCliPackageJson: true,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
