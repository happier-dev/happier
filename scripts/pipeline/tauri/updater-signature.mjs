// @ts-check

import path from 'node:path';

/** @param {string} platformKey @param {readonly string[]} matches */
export function pickUpdaterSignature(platformKey, matches) {
  if (platformKey.startsWith('windows-')) {
    const preferred =
      matches.find((m) => m.endsWith('.nsis.zip.sig')) ||
      matches.find((m) => m.endsWith('.nsis.sig')) ||
      matches.find((m) => m.endsWith('.exe.zip.sig')) ||
      matches.find((m) => m.endsWith('.exe.sig')) ||
      matches.find((m) => m.endsWith('.msi.zip.sig')) ||
      matches.find((m) => m.endsWith('.msi.sig')) ||
      matches[0];
    if (!preferred) throw new Error('Expected at least one Windows updater signature; found 0');
    if (matches.length > 1) {
      const relative = (file) => path.relative(process.cwd(), file) || file;
      console.error(`Found multiple Windows updater signatures for ${platformKey}; using preferred artifact: ${relative(preferred)}`);
      console.error('All matches:');
      for (const match of matches) console.error(`  ${relative(match)}`);
    }
    return preferred;
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one updater signature for ${platformKey}; found ${matches.length}`);
  }
  return matches[0];
}
