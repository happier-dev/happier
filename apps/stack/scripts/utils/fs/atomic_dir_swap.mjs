import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function rand() {
  return Math.random().toString(16).slice(2);
}

async function renameForPublication(
  from,
  to,
  { platform, renameImpl, waitImpl, maxRetries = 8 },
) {
  let retry = 0;
  while (true) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (
        platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
        || retry >= maxRetries
      ) {
        throw error;
      }
      await waitImpl(Math.min(25 * (2 ** retry), 400));
      retry += 1;
    }
  }
}

export async function buildIntoTempThenReplace(
  targetDir,
  buildFn,
  {
    platform = process.platform,
    renameImpl = rename,
    waitImpl = wait,
  } = {},
) {
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
    await renameForPublication(outDir, backupDir, { platform, renameImpl, waitImpl });
    hadExisting = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    await renameForPublication(tmpDir, outDir, { platform, renameImpl, waitImpl });
  } catch (err) {
    if (hadExisting) {
      await renameForPublication(backupDir, outDir, { platform, renameImpl, waitImpl }).catch((restoreErr) => {
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
