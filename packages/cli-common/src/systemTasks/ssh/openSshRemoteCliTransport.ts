import { readdir } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { parseJsonLinesBestEffort, runOpenSshRemoteCommand, safeBashSingleQuote, transferOpenSshFile, type OpenSshAuth } from '../../ssh/index.js';
import { installRemoteFirstPartyComponent } from '../kinds/remoteFirstPartyPayloadInstaller.js';
import type { SystemTaskSshConnectionConfig } from '../kinds/relayRuntimeKinds.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { DedicatedDaemonBootstrapExec } from './dedicatedDaemonBootstrap.js';
import type { RemoteCliInstallTransport } from './installRemoteCli.js';
import { buildBootstrapRootCommand, buildDedicatedDaemonInvocationCommand } from './remoteBootstrapCommandBuilder.js';
import { normalizeRemoteReleaseArch, normalizeRemoteReleaseOs } from './remoteFirstPartyInstallPath.js';
import { sshCommandFailure } from './sshCommandFailure.js';

/** Node-only SSH/file-transfer adapter; the portable owner selects installation placement. */
export function createOpenSshRemoteCliTransport(input: Readonly<{
  ssh: SystemTaskSshConnectionConfig;
  auth: OpenSshAuth;
  knownHostsMode: 'app' | 'system';
  knownHostsPath?: string;
  channel: 'stable' | 'preview' | 'dev';
  signal?: AbortSignal;
  exec?: DedicatedDaemonBootstrapExec;
}>): RemoteCliInstallTransport {
  const execute: DedicatedDaemonBootstrapExec = async request => {
    try {
      return await runOpenSshRemoteCommand({
        target: input.ssh.target, port: input.ssh.port, sshConfigFile: input.ssh.sshConfigFile,
        knownHostsPath: input.knownHostsPath, knownHostsMode: input.knownHostsMode, auth: input.auth,
        remoteCommand: ['bash', '-lc', safeBashSingleQuote(request.command)],
        connectTimeoutSec: 10, serverAliveIntervalSec: 15, serverAliveCountMax: 2,
        signal: request.signal, timeoutMs: request.timeoutMs, input: request.input,
        onStdoutChunk: request.onStdoutChunk, includeStdoutInError: false, rejectOnNonZero: false,
      });
    } catch (error) {
      request.signal?.throwIfAborted();
      throw sshCommandFailure(error instanceof Error ? error.message : '');
    }
  };
  const exec: DedicatedDaemonBootstrapExec = request => {
    input.signal?.throwIfAborted();
    request.signal?.throwIfAborted();
    return (input.exec ?? execute)({ ...request, signal: request.signal ?? input.signal });
  };
  return {
    exec,
    install: async placement => installRemoteFirstPartyComponent({
      componentId: 'happier-cli', channel: input.channel, ssh: input.ssh, knownHostsMode: input.knownHostsMode,
      ...(placement.remoteHomeDir ? { remoteHomeDir: placement.remoteHomeDir } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }, {
      resolveRemoteReleaseTarget: async ({ signal }) => {
        const result = await exec({ command: [
          "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
          '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
          '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
        ].join(' '), signal });
        if (result.status !== 0) throw sshCommandFailure(result.stderr || result.stdout, result);
        const facts = parseJsonLinesBestEffort<Record<string, unknown>>(result.stdout);
        return { os: normalizeRemoteReleaseOs(facts?.platform), arch: normalizeRemoteReleaseArch(facts?.arch) };
      },
      runRemoteText: ({ remoteCommand, signal }) => exec({
        command: placement.daemonUsername ? buildDedicatedDaemonInvocationCommand(remoteCommand) : remoteCommand, signal,
      }),
      copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal }) => {
        const staging = placement.daemonUsername ? await exec({ command: 'mktemp -d /tmp/happier-bootstrap-upload.XXXXXXXX', signal }) : undefined;
        const temporary = staging?.stdout.trim();
        if (placement.daemonUsername && (staging?.status !== 0 || !temporary?.startsWith('/tmp/happier-bootstrap-upload.') || /[\r\n\0]/u.test(temporary))) {
          throw new SystemTaskExecutionError('remote_command_failed', 'SSH payload transfer staging failed.');
        }
        try {
          try {
            await transferOpenSshFile({
              direction: 'upload', target: input.ssh.target, localPath, remotePath: temporary ?? remotePath, recursive: true,
              sshConfigFile: input.ssh.sshConfigFile, knownHostsPath: input.knownHostsPath, knownHostsMode: input.knownHostsMode,
              auth: input.auth, port: input.ssh.port, connectTimeoutSec: 10, serverAliveIntervalSec: 15, serverAliveCountMax: 2,
              ...(signal ? { signal } : {}), timeoutMs: 15 * 60_000,
            });
          } catch (error) {
            signal?.throwIfAborted();
            throw sshCommandFailure(error instanceof Error ? error.message : '');
          }
          if (temporary) {
            const archiveRoot = posix.join(remotePath, basename(localPath));
            const commands = [`install -d -o happier -g happier -m 0700 -- ${safeBashSingleQuote(archiveRoot)}`];
            for (const entry of await readdir(localPath, { withFileTypes: true })) {
              if (!entry.isFile()) throw new SystemTaskExecutionError('invalid_payload', 'The binary payload archive was not a regular file.');
              commands.push(`install -o happier -g happier -m 0600 -- ${safeBashSingleQuote(posix.join(temporary, basename(localPath), entry.name))} ${safeBashSingleQuote(posix.join(archiveRoot, entry.name))}`);
            }
            const copied = await exec({ command: buildBootstrapRootCommand(['set -eu', ...commands].join('; ')), signal });
            if (copied.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'SSH payload transfer failed.');
          }
        } finally {
          // Cleanup retains the existing uncancelled transport, not a new retry or lifecycle owner.
          if (temporary) await execute({ command: `rm -rf -- ${safeBashSingleQuote(temporary)}` });
        }
      },
    }),
  };
}
