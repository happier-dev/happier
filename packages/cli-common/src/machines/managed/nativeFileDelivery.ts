import { safeBashSingleQuote } from '../../ssh/shellQuote.js';
import { buildBootstrapRootCommand } from '../../systemTasks/ssh/remoteBootstrapCommandBuilder.js';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { JsonValue } from '@happier-dev/protocol';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';

export type ManagedNativeFileDeliveryIO = ManagedNativeBootstrapIO & Readonly<{
  dedicatedIdentity?: boolean;
  bootstrapExec?: ManagedNativeBootstrapIO['exec'];
  cleanupExec?: ManagedNativeBootstrapIO['exec'];
}>;

/** The existing native file transfer owns fragmentation for filesystem and HTTP
 * sources alike. A complete archive is published only after every fragment. */
export async function deliverManagedNativeArchive(input: Readonly<{
  chunks: AsyncIterable<Uint8Array>; guestPath: string; resource: JsonValue; signal?: AbortSignal;
  totalBytes?: number;
  onProgress?(progress: Readonly<{ transferredBytes: number; totalBytes: number }>): void;
}>, native: ManagedNativeFileDeliveryIO): Promise<void> {
  const partial = `${input.guestPath}.partial`;
  const chunk = `${input.guestPath}.chunk`;
  // This is the incumbent Action body boundary, including actual JSON metadata.
  const metadataBytes = new TextEncoder().encode(JSON.stringify({ resource: input.resource, guestPath: chunk, bytesBase64: '' })).byteLength;
  const chunkBytes = Math.floor((MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 - metadataBytes) / 4) * 3;
  if (chunkBytes < 1) throw new SystemTaskExecutionError('invalid_payload', 'Native file metadata exceeds the Action body budget.');
  const exec = async (command: string) => {
    input.signal?.throwIfAborted();
    const result = await native.exec({ command, signal: input.signal });
    input.signal?.throwIfAborted();
    if (result.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload staging failed.');
  };
  let transferPath: string | undefined;
  if (native.dedicatedIdentity) {
    if (!native.bootstrapExec || !native.cleanupExec) throw new SystemTaskExecutionError('managed_enrollment_unavailable', 'Dedicated file delivery requires its bootstrap transport.');
    const staged = await native.bootstrapExec({ command: 'mktemp /tmp/happier-bootstrap-transfer.XXXXXXXX', signal: input.signal });
    transferPath = staged.stdout.trim();
    if (staged.status !== 0 || !transferPath.startsWith('/tmp/happier-bootstrap-transfer.') || /[\r\n\0]/u.test(transferPath)) {
      throw new SystemTaskExecutionError('remote_command_failed', 'Native payload transfer staging failed.');
    }
  }
  try {
    await exec(`umask 077; : > ${safeBashSingleQuote(partial)}`);
    let transferredBytes = 0;
    const report = () => {
      if (input.totalBytes !== undefined) input.onProgress?.({ transferredBytes, totalBytes: input.totalBytes });
    };
    report();
    const buffer = new Uint8Array(Math.min(chunkBytes, input.totalBytes ?? chunkBytes));
    let filled = 0;
    const flush = async () => {
      if (!filled) return;
      await native.putFile({ path: transferPath ?? chunk, bytes: buffer.subarray(0, filled), signal: input.signal });
      if (transferPath) {
        const copied = await native.bootstrapExec!({ command: buildBootstrapRootCommand(`install -o happier -g happier -m 0600 -- ${safeBashSingleQuote(transferPath)} ${safeBashSingleQuote(chunk)}`), signal: input.signal });
        if (copied.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload transfer failed.');
      }
      await exec(`cat -- ${safeBashSingleQuote(chunk)} >> ${safeBashSingleQuote(partial)} && rm -- ${safeBashSingleQuote(chunk)}`);
      transferredBytes += filled;
      filled = 0;
      report();
    };
    for await (const bytes of input.chunks) {
      input.signal?.throwIfAborted();
      for (let offset = 0; offset < bytes.byteLength;) {
        const take = Math.min(bytes.byteLength - offset, buffer.byteLength - filled);
        buffer.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === buffer.byteLength) await flush();
      }
    }
    await flush();
    await exec(`mv -- ${safeBashSingleQuote(partial)} ${safeBashSingleQuote(input.guestPath)}`);
  } finally {
    if (transferPath) await native.cleanupExec!({ command: `rm -f -- ${safeBashSingleQuote(transferPath)}` });
  }
}
