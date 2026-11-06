import { open } from 'node:fs/promises';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import { MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { JsonValue } from '@happier-dev/protocol';
import type { ManagedNativeBootstrapIO } from './enrollment';

/** The installer owns a private unique guest staging directory. Publish its
 * archive only after every fragment has settled. Cancelled/failed fragments
 * can never become input to extraction, for any native provisioner plugin. */
export async function deliverManagedNativeFile(input: Readonly<{
  localPath: string; guestPath: string; resource: JsonValue; signal?: AbortSignal;
  onProgress?(progress: Readonly<{ transferredBytes: number; totalBytes: number }>): void;
}>, native: ManagedNativeBootstrapIO): Promise<void> {
  const partial = `${input.guestPath}.partial`;
  const chunk = `${input.guestPath}.chunk`;
  // Native role dispatch is in-process, but uses the incumbent public Action
  // body budget as its per-call materialization boundary. Base64 is ASCII and
  // grows by four bytes per three source bytes. Reserve actual JSON metadata,
  // including escaped paths/resource; do not impose a total archive ceiling.
  const metadataBytes = Buffer.byteLength(JSON.stringify({ resource: input.resource, guestPath: chunk, bytesBase64: '' }));
  const chunkBytes = Math.floor((MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 - metadataBytes) / 4) * 3;
  if (chunkBytes < 1) throw new SystemTaskExecutionError('invalid_payload', 'Native file metadata exceeds the Action body budget.');
  const exec = async (command: string) => {
    input.signal?.throwIfAborted();
    const result = await native.exec({ command, signal: input.signal });
    input.signal?.throwIfAborted();
    if (result.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload staging failed.');
  };
  input.signal?.throwIfAborted();
  const file = await open(input.localPath, 'r');
  try {
    await exec(`umask 077; : > ${safeBashSingleQuote(partial)}`);
    const totalBytes = (await file.stat()).size;
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, totalBytes));
    let transferredBytes = 0;
    input.onProgress?.({ transferredBytes, totalBytes });
    while (true) {
      input.signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      input.signal?.throwIfAborted();
      if (bytesRead === 0) break;
      await native.putFile({ path: chunk, bytes: buffer.subarray(0, bytesRead), signal: input.signal });
      await exec(`cat -- ${safeBashSingleQuote(chunk)} >> ${safeBashSingleQuote(partial)} && rm -- ${safeBashSingleQuote(chunk)}`);
      transferredBytes += bytesRead;
      input.onProgress?.({ transferredBytes, totalBytes });
    }
    await exec(`mv -- ${safeBashSingleQuote(partial)} ${safeBashSingleQuote(input.guestPath)}`);
  } finally { await file.close(); }
}
