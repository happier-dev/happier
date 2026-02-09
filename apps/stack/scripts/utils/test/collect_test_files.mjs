import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

function matchesAnySuffix(name, suffixes = []) {
  return suffixes.some((suffix) => name.endsWith(suffix));
}

export async function collectTestFiles({
  dir,
  includeSuffixes = ['.test.mjs'],
  excludeSuffixes = [],
} = {}) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles({ dir: path, includeSuffixes, excludeSuffixes })));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!matchesAnySuffix(entry.name, includeSuffixes)) continue;
    if (matchesAnySuffix(entry.name, excludeSuffixes)) continue;
    files.push(path);
  }
  files.sort();
  return files;
}
