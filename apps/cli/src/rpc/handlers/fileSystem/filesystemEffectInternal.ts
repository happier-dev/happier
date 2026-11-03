import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { FilesystemEffectConfigurationSchema, executeFilesystemEffectOperation, invalidOperation } from './filesystemEffectOperation';
import { createFilesystemEffectByteOwner } from './filesystemEffectBytes';

async function writeResponse(output: Writable, response: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolve());
  });
}

/** One finalized process owns its admitted configuration and byte lifetime.
 * Newline-delimited private requests preserve pipe backpressure; EOF/cancellation
 * closes native descriptors and staged uploads. A finite legacy request remains
 * supported for the existing local-copy consumer. */
export async function runFilesystemEffectInternal(input: Readable, output: Writable, signal?: AbortSignal): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let owner: ReturnType<typeof createFilesystemEffectByteOwner> | undefined;
  const abort = () => { lines.close(); input.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const line of lines) {
      signal?.throwIfAborted();
      let request: unknown;
      try { request = JSON.parse(line); } catch { throw invalidOperation(); }
      if (!owner) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalidOperation();
        if (!('kind' in request)) {
          await writeResponse(output, await executeFilesystemEffectOperation(request, signal));
          return;
        }
        const { kind, ...configuration } = request;
        if (kind !== 'initialize') throw invalidOperation();
        owner = createFilesystemEffectByteOwner(FilesystemEffectConfigurationSchema.parse(configuration), signal);
        await writeResponse(output, { ok: true, value: { ready: true } });
        continue;
      }
      try {
        const value = await owner.execute(request);
        signal?.throwIfAborted();
        await writeResponse(output, { ok: true, value });
      } catch (error) {
        signal?.throwIfAborted();
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'filesystem_effect_operation_failed';
        await writeResponse(output, { ok: false, code });
      }
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', abort);
    lines.close();
    await owner?.dispose();
  }
}
