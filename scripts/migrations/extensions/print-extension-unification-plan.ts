import { pathToFileURL } from 'node:url';

import { EXTENSION_UNIFICATION_MOVE_MAP, buildExtensionUnificationRewriteRules } from './extension-unification-move-map.ts';

export function printExtensionUnificationPlan(): string {
  const moveLines = EXTENSION_UNIFICATION_MOVE_MAP.map((entry) => `MOVE ${entry.from} -> ${entry.to}`);
  const rewriteLines = buildExtensionUnificationRewriteRules().map((rule) => `REWRITE ${rule.from} -> ${rule.to}`);
  return [
    '# Extension Unification Packaging Move Plan',
    '',
    '## Moves',
    ...moveLines,
    '',
    '## Import Rewrites',
    ...rewriteLines,
  ].join('\n');
}

export async function main(): Promise<void> {
  console.log(printExtensionUnificationPlan());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
