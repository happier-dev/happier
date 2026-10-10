import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';
import { withJsonOwnerFileLock } from '../../utils/proc/jsonOwnerFileLock.mjs';

function supersededError() {
  const error = new Error('Source Stack start superseded by a newer start for this stack');
  error.name = 'AbortError';
  error.code = 'ESOURCESTARTSUPERSEDED';
  return error;
}

/** Only pending source preparation is replaceable. Publication and replacement
 * share the existing file-lock primitive so an old start cannot publish after a
 * successor claims this stack. No process is signalled by this owner.
 */
export async function beginPendingSourceStart({ stackBaseDir }) {
  const directory = join(stackBaseDir, 'source-runtime');
  const markerPath = join(directory, 'start.pending.json');
  const lockPath = `${markerPath}.lock`;
  const requestId = randomUUID();
  const controller = new AbortController();
  await mkdir(directory, { recursive: true });
  await withJsonOwnerFileLock(async () => {
    await writeJsonAtomic(markerPath, { requestId, pid: process.pid });
  }, { lockPath });
  let closed = false;
  const checkCurrent = async () => {
    if (closed || controller.signal.aborted) return;
    const current = await readJsonIfExists(markerPath);
    if (!closed && current?.requestId !== requestId) controller.abort(supersededError());
  };
  const watcher = watch(directory, { persistent: false }, () => {
    void checkCurrent().catch(error => controller.abort(error));
  });
  watcher.on('error', error => controller.abort(error));
  const close = () => { closed = true; watcher.close(); };
  await checkCurrent();
  const removeOwnMarker = async () => {
    if ((await readJsonIfExists(markerPath))?.requestId === requestId) await unlink(markerPath);
  };
  return {
    signal: controller.signal,
    async publish(fn) {
      return await withJsonOwnerFileLock(async () => {
        controller.signal.throwIfAborted();
        if ((await readJsonIfExists(markerPath))?.requestId !== requestId) {
          controller.abort(supersededError());
          controller.signal.throwIfAborted();
        }
        const result = await fn();
        close();
        await removeOwnMarker();
        return result;
      }, { lockPath, signal: controller.signal });
    },
    async dispose() {
      close();
      await withJsonOwnerFileLock(removeOwnMarker, { lockPath });
    },
  };
}
