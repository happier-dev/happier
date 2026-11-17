import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { SystemTaskExecutionError, type ManagedNativePayloadInstallation } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { installRemoteFirstPartyComponentPayload } from '@happier-dev/cli-common/systemTasks';
import { deliverManagedNativeFile } from './nativeFileDelivery';

/** Node/filesystem strategy only; shared enrollment owns placement and identity. */
export async function installManagedNativePayload(input: ManagedNativePayloadInstallation): Promise<Readonly<{ binaryPath: string }>> {
  const { channel, signal, dedicatedIdentity, home, os, arch, remoteHomeDir, resource, exec, putFile, bootstrapExec, cleanupExec } = input;
  return await installRemoteFirstPartyComponentPayload({
    requireHomePayload: true,
    homeUrl: input.homeUrl,
    guestCliPayload: input.guestCliPayload,
    componentId: 'happier-cli', channel, signal, onPhase: input.onPhase,
    ...(remoteHomeDir ? { remoteHomeDir } : {}),
  }, {
    resolveRemoteReleaseTarget: async () => ({ os, arch }),
    // Enrollment starts its daemon explicitly; payload promotion must never
    // repair or restart a guest service through an incumbent CLI migration.
    runRemoteText: async ({ remoteCommand, signal: commandSignal }) => exec({
      command: `export HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION=1; ${remoteCommand}`, signal: commandSignal,
    }),
    copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal: copySignal }) => {
      const archiveRoot = posix.resolve(home, remotePath, localPath.split(/[\\/]/u).at(-1)!);
      const mkdirResult = await exec({ command: `mkdir -p ${safeBashSingleQuote(archiveRoot)}`, signal: copySignal });
      if (mkdirResult.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'Native payload staging failed.');
      for (const entry of await readdir(localPath, { withFileTypes: true })) {
        if (!entry.isFile()) throw new SystemTaskExecutionError('invalid_payload', 'The binary payload archive was not a regular file.');
        await deliverManagedNativeFile({ localPath: join(localPath, entry.name), guestPath: `${archiveRoot}/${entry.name}`,
          resource, signal: copySignal, onProgress: input.onTransferProgress }, { exec, putFile, dedicatedIdentity, bootstrapExec, cleanupExec });
      }
    },
  });
}
