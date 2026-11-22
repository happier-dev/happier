import type { LimaCommandResult, LimaExecutor } from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectMachineProvisionerGuestCommandFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { mkdir } from 'node:fs/promises';

// OpenSSH's non-PTY channel closes its input when the carrier dies. Leave
// that pipe open after delivering the command's finite stdin and use EOF
// to stop its guest-side process group. The command itself receives its
// original input, and its normal exit status remains the channel's status.
const guestCommandLifetime = `
IFS= read -r payload || exit 1
set -m
(printf '%s' "$payload" | base64 -d | "$@") &
command_group=$!
(
  if ! IFS= read -r unused; then
    # The command may switch to the enrolled daemon user. The guest's
    # bootstrap login already has sudo for that switch.
    sudo -n -- /bin/kill -KILL -- "-$command_group" 2>/dev/null ||
      kill -KILL -- "-$command_group" 2>/dev/null
  fi
) <&0 >/dev/null 2>&1 &
watcher=$!
# Bash job control reports nonzero exits on the supervisor stderr.
wait "$command_group" 2>/dev/null
status=$?
kill "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
exit "$status"
`;

export type LimaProcessCommandResult = LimaCommandResult & Readonly<{ process: PluginProcessResult }>;

export class LimaNativeCommandError extends PluginError {
  constructor(readonly nativeCause: Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }>) {
    super({ code: nativeCause.command === 'create' ? 'lima_create_failed'
      : nativeCause.command === 'edit' ? 'lima_resize_failed'
      : nativeCause.command === 'delete' ? 'lima_delete_failed'
      : nativeCause.command === 'stop' ? 'lima_stop_failed' : 'lima_start_failed', details: { nativeCause } });
  }
}

/** The public, invocation-owned process service is the only Lima process boundary. */
export function createLimaSdkExecutor({ exec, executable, signal, tieGuestToCarrier = false }: Readonly<{
  exec: Pick<ExecService, 'run'> & Partial<Pick<ExecService, 'spawn'>>; executable: ManagedExecutableRef; signal: AbortSignal; tieGuestToCarrier?: boolean;
}>): LimaExecutor<LimaProcessCommandResult> & Readonly<{ channel(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<PluginProcessHandle> }> {
  const capture: LimaExecutor<LimaProcessCommandResult>['capture'] = async (_command, args, options) => {
    if (options?.cwd !== undefined) await mkdir(options.cwd, { recursive: true, mode: 0o700 });
    const placement = { ...(options?.cwd === undefined ? {} : { cwd: options.cwd }), ...(options?.env ? { env: options.env } : {}) };
    const stdin = typeof options?.input === 'string' ? new TextEncoder().encode(options.input) : options?.input;
    const process = tieGuestToCarrier && args[0] === 'shell'
      ? await captureGuestWithLifetime(args, stdin, placement)
      : await exec.run({
          executable, args, ...placement, ...(stdin === undefined ? {} : { stdin }),
        }, { signal,
          ...(args[0] === 'start' || args[0] === 'restart' ? { descendantDisposition: 'preserve-on-success' as const } : {}),
          ...(args[0] === 'shell' ? { outputDelivery: 'invocation' as const } : {}),
        });
    if ((args[0] === 'list' || args[0] === '--version' || args[0] === 'info') && (process.stdoutTruncated || process.stderrTruncated)) {
      throw Object.assign(new Error('native Lima observation is incomplete'), { code: 'LIMA_INSPECT_UNAVAILABLE' });
    }
    const observed = process.termination.observed;
    const exitCode = observed.kind === 'exit' && process.termination.requestedBy.kind === 'none' ? observed.exitCode : null;
    const command = args[0];
    if ((command === 'create' || command === 'start' || command === 'restart' || command === 'stop' || command === 'edit' || command === 'delete') && exitCode !== 0) {
      throw new LimaNativeCommandError(projectMachineProvisionerGuestCommandFailure({
        command, exitCode, stderr: process.stderr, stderrTruncated: process.stderrTruncated,
      }));
    }
    return {
      exitCode,
      out: new TextDecoder().decode(process.stdout), err: new TextDecoder().decode(process.stderr), process,
    };
  };
  async function captureGuestWithLifetime(args: readonly string[], stdin: Uint8Array | undefined,
    placement: { cwd?: string; env?: Readonly<Record<string, string>> }) {
    if (!exec.spawn) throw Object.assign(new Error('native Lima channel is unavailable'), { code: 'LIMA_CHANNEL_UNSUPPORTED' });
    const guestStart = args.indexOf('--') + 1;
    const handle = await exec.spawn({ executable, ...placement,
      args: [...args.slice(0, guestStart), '/bin/bash', '-c', guestCommandLifetime, 'happier-exec', ...args.slice(guestStart)],
    }, { signal, outputDelivery: 'invocation' });
    try {
      await handle.write(Buffer.from(`${Buffer.from(stdin ?? []).toString('base64')}
`));
      const result = await handle.wait();
      const { observed, requestedBy } = result.termination;
      // Only this non-PTY carrier closes the watchdog's stdin and stops the
      // guest group on abort. Other native process terminations stay raw.
      if (requestedBy.kind === 'abort' && (observed.kind === 'exit' || observed.kind === 'signal')) {
        throw new PluginError({ code: 'cancelled' });
      }
      return result;
    } finally {
      await handle.dispose();
    }
  }
  // The `stream` role's process: the invocation feeds its stdin and observes its output.
  const channel = async (_command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }) => {
    if (!exec.spawn) throw Object.assign(new Error('native Lima channel is unavailable'), { code: 'LIMA_CHANNEL_UNSUPPORTED' });
    if (options?.cwd !== undefined) await mkdir(options.cwd, { recursive: true, mode: 0o700 });
    return exec.spawn({ executable, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }), ...(options?.env ? { env: options.env } : {}) },
      { signal, outputDelivery: 'invocation' });
  };
  return { capture, run: capture, channel };
}
