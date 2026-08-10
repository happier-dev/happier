// @ts-check

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function fileSha256(path) {
  const targetPath = String(path ?? '').trim();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const bytes = await readFile(targetPath);
      return createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
      if (code === 'ENOENT' && attempt < 9) {
        await delay(50);
        continue;
      }
      throw error;
    }
  }
  // unreachable: loop always returns or throws
}

export async function writeChecksumsFile({ product, version, artifacts, outDir }) {
  const checksumsPath = join(outDir, `checksums-${product}-v${version}.txt`);
  const lines = [];
  for (const artifact of artifacts) {
    const hash = await fileSha256(artifact.path);
    lines.push(`${hash}  ${artifact.name}`);
  }
  await writeFile(checksumsPath, `${lines.join('\n')}\n`, 'utf-8');
  return checksumsPath;
}
