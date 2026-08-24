import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as runBundledPluginPublisher } from './generateBundledPluginEntries.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageName = String(process.env.npm_package_name ?? '').trim();
if (!packageName.startsWith('@happier-dev/plugins-')) {
  throw new Error(`Expected a first-party Plugin package name, received '${packageName || '<missing>'}'`);
}

await runBundledPluginPublisher([
  '--root', repoRoot,
  '--mode', 'check',
  '--scope', 'projections',
  '--workspace', packageName,
]);
