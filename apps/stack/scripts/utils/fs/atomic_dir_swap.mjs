import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function rand() {
  return Math.random().toString(16).slice(2);
}

export async function buildIntoTempThenReplace(targetDir, buildFn) {
  const outDir = String(targetDir ?? '').trim();
  if (!outDir) throw new Error('[fs] buildIntoTempThenReplace: missing targetDir');
  if (typeof buildFn !== 'function') throw new Error('[fs] buildIntoTempThenReplace: buildFn must be a function');

  const parent = dirname(outDir);
  const tmpDir = join(parent, `.tmp.${Date.now()}.${process.pid}.${rand()}`);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  let ok = false;
  try {
    await buildFn(tmpDir);
    ok = true;
  } finally {
    if (!ok) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Swap only after a successful build.
  const backupDir = join(parent, `.backup.${Date.now()}.${process.pid}.${rand()}`);
  let hadExisting = false;
  try {
    await rename(outDir, backupDir);
    hadExisting = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    await rename(tmpDir, outDir);
  } catch (err) {
    if (hadExisting) {
      await rename(backupDir, outDir).catch((restoreErr) => {
        if (err && typeof err === 'object') {
          err.restoreError = restoreErr;
        }
      });
    }
    throw err;
  }

  if (hadExisting) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}
