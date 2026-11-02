import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { buildBootstrapRootCommand, SystemTaskExecutionError, type ManagedNativePayloadInstallation, type ManagedNativeBootstrapIO } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { installRemoteFirstPartyComponentPayload } from '@happier-dev/cli-common/systemTasks';
import { deliverManagedNativeFile } from './nativeFileDelivery';

/** Node/filesystem strategy only; shared enrollment owns placement and identity. */
export async function installManagedNativePayload(input: ManagedNativePayloadInstallation): Promise<Readonly<{ binaryPath: string }>> {
  const { channel, signal, dedicatedIdentity, home, os, arch, remoteHomeDir, resource, exec, putFile, bootstrapExec, cleanupExec } = input;
  return await installRemoteFirstPartyComponentPayload({
    componentId: 'happier-cli', channel, signal,
    ...(remoteHomeDir ? { remoteHomeDir } : {}),
  }, {
    resolveRemoteReleaseTarget: async () => ({ os, arch }),
    runRemoteText: async ({ remoteCommand, signal: commandSignal }) => exec({ command: remoteCommand, signal: commandSignal }),
    copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal: copySignal }) => {
      const archiveRoot = posix.resolve(home, remotePath, localPath.split(/[\\/]/u).at(-1)!);
      const mkdirResult = await exec({ command: `mkdir -p ${safeBashSingleQuote(archiveRoot)}`, signal: copySignal });
      if (mkdirResult.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload staging failed.');
      // Native delivery is serial. Reuse one bootstrap-owned private file
      // across its fragments; only root installs into happier-owned staging.
      let transferPath: string | undefined;
      if (dedicatedIdentity) {
        const staged = await bootstrapExec({ command: 'mktemp /tmp/happier-bootstrap-transfer.XXXXXXXX', signal: copySignal });
        transferPath = staged.stdout.trim();
        if (staged.status !== 0 || !transferPath.startsWith('/tmp/happier-bootstrap-transfer.') || /[\r\n\0]/u.test(transferPath)) {
          throw new SystemTaskExecutionError('remote_command_failed', 'Native payload transfer staging failed.');
        }
      }
      try {
        const ownedTransferPath = transferPath;
        const deliverFile: ManagedNativeBootstrapIO['putFile'] = ownedTransferPath ? async request => {
          await putFile({ ...request, path: ownedTransferPath });
          const copied = await bootstrapExec({ command: buildBootstrapRootCommand(`install -o happier -g happier -m 0600 -- ${safeBashSingleQuote(ownedTransferPath)} ${safeBashSingleQuote(request.path)}`), signal: request.signal });
          if (copied.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload transfer failed.');
        } : putFile;
        for (const entry of await readdir(localPath, { withFileTypes: true })) {
          if (!entry.isFile()) throw new SystemTaskExecutionError('invalid_payload', 'The binary payload archive was not a regular file.');
          await deliverManagedNativeFile({ localPath: join(localPath, entry.name), guestPath: `${archiveRoot}/${entry.name}`,
            resource, signal: copySignal }, { exec, putFile: deliverFile });
        }
      } finally {
        // Retirement/cancellation must not prevent exact owned-temp cleanup.
        if (transferPath) await cleanupExec({ command: `rm -f -- ${safeBashSingleQuote(transferPath)}` });
      }
    },
  });
}
