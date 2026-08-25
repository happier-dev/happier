import { readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import cliDistBuildManifest from '../../packages/cli-common/cliDistBuildManifest.cjs';

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function extractLocalImportSpecifiersFromJs(text) {
  return cliDistBuildManifest.extractRelativeModuleSpecifiers(text);
}

export function hasMissingLocalImportsSync({ distDir, entryPaths }) {
  const root = resolve(distDir);
  const visited = new Set();
  const queue = [...entryPaths].map((entryPath) => resolve(entryPath));

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let contents = '';
    try {
      contents = readFileSync(current, 'utf-8');
    } catch {
      return true;
    }

    for (const spec of extractLocalImportSpecifiersFromJs(contents)) {
      const resolvedImport = resolve(dirname(current), spec);
      try {
        readFileSync(resolvedImport);
      } catch {
        return true;
      }
      if (
        (resolvedImport === root || resolvedImport.startsWith(root + sep))
        && !visited.has(resolvedImport)
      ) {
        queue.push(resolvedImport);
      }
    }

    if (visited.size > 5_000) return true;
  }

  return false;
}

export async function assertNoMissingLocalImports({ distDir, entryPath, label = 'dist build' }) {
  const root = resolve(distDir);
  const entry = resolve(entryPath);

  const visited = new Set();
  const queue = [entry];
  const missing = [];

  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    const abs = resolve(current);
    if (visited.has(abs)) continue;
    visited.add(abs);

    let contents = '';
    try {
      contents = await readFile(abs, 'utf-8');
    } catch {
      missing.push({ from: abs, spec: '(unreadable)' });
      continue;
    }

    for (const spec of extractLocalImportSpecifiersFromJs(contents)) {
      const resolvedImport = resolve(dirname(abs), spec);
      if (!(await pathExists(resolvedImport))) {
        missing.push({ from: abs, spec });
        continue;
      }
      if (resolvedImport === root || resolvedImport.startsWith(root + sep)) {
        if (!visited.has(resolvedImport)) queue.push(resolvedImport);
      }
    }

    if (visited.size > 5_000) {
      throw new Error(`[local] dist import graph too large while validating ${entryPath} (visited=${visited.size})`);
    }
  }

  if (missing.length) {
    const preview = missing
      .slice(0, 8)
      .map((m) => `- ${m.spec} (from ${m.from})`)
      .join('\n');
    throw new Error(
      `[local] ${label} looks partial (missing local imports).\n` +
        `Entrypoint: ${entryPath}\n` +
        `Missing (${missing.length}):\n${preview}`,
    );
  }
}
