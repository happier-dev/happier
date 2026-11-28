import { isSuccessfulProcessResult } from '@happier-dev/plugin-sdk/exec';
import { quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { MachineProvisionerNativeExecResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { CoderResource, ROLE_SCHEMAS } from './schemas.js';

/** Only the control-plane token is redacted. All other output remains bytes,
 * including non-UTF8 data and a nonzero remote exit. No output is streamed
 * before this projection; native enrollment accepts buffered IO. */
function redact(bytes: Uint8Array, token: string) {
  const source = Buffer.from(bytes); const secret = Buffer.from(token);
  const parts: Buffer[] = []; let offset = 0; let match = source.indexOf(secret);
  if (match < 0) return source;
  while (match >= 0) { parts.push(source.subarray(offset, match), Buffer.from('[redacted]')); offset = match + secret.length; match = source.indexOf(secret, offset); }
  parts.push(source.subarray(offset)); return Buffer.concat(parts);
}

// Coder's non-PTY `coder ssh` channel closes remote stdin when the local
// carrier exits while `coder agent --no-reap` keeps remote children alive.
// Leave stdin open after delivering the command's finite base64 payload and
// use EOF (or direct carrier signal) to stop the guest-side process group.
// Prefer bash `set -m` (non-TTY job control without stderr noise, matching
// machine-lima), falling back to POSIX `setsid` on minimal guests without bash.
const guestCommandLifetime = `
IFS= read -r payload || exit 1
if [ -n "\${BASH_VERSION:-}" ]; then
  set -m
  (printf '%s' "$payload" | base64 -d | "$@") &
  command_group=$!
  set +m
elif command -v setsid >/dev/null 2>&1; then
  printf '%s' "$payload" | base64 -d | setsid "$@" &
  command_group=$!
else
  printf '%s' "$payload" | base64 -d | "$@" &
  command_group=$!
fi
stop_group() {
  if kill -TERM -- "-$command_group" 2>/dev/null ||
     kill -TERM "-$command_group" 2>/dev/null ||
     kill -TERM "$command_group" 2>/dev/null; then
    sleep 0.2 2>/dev/null || sleep 1
    kill -KILL -- "-$command_group" 2>/dev/null ||
      kill -KILL "-$command_group" 2>/dev/null ||
      kill -KILL "$command_group" 2>/dev/null || true
  elif sudo -n -- /bin/kill -TERM -- "-$command_group" 2>/dev/null; then
    sleep 0.2 2>/dev/null || sleep 1
    sudo -n -- /bin/kill -KILL -- "-$command_group" 2>/dev/null || true
  fi
}
supervisor=$$
trap 'trap "" INT TERM HUP; stop_group; [ -n "\${watcher:-}" ] && kill "$watcher" 2>/dev/null; exit 143' INT TERM HUP
exec 3<&0
(
  if ! IFS= read -r unused <&3; then
    kill -TERM "$supervisor" 2>/dev/null
  fi
) </dev/null >/dev/null 2>&1 &
watcher=$!
exec 3<&-
wait "$command_group" 2>/dev/null
status=$?
trap '' INT TERM HUP
kill "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
exit "$status"
`;
const guestCommandBootstrap = 'script=$1; shift; if command -v bash >/dev/null 2>&1; then exec bash -c "$script" happier-exec "$@"; fi; eval "$script"';

/** Finite native Coder SSH only. Shared enrollment owns pairing and daemon
 * lifecycle. Finite `exec` binds guest process-group lifetime to stdin EOF. */
export function createCoderTransport(input: { exec: Pick<ExecService, 'run'> & Partial<Pick<ExecService, 'spawn'>>; executable: ManagedExecutableRef; signal: AbortSignal; endpoint: string; token: string }) {
  function ssh(resource: CoderResource, argv: readonly string[], allowWake?: false, privateEnvironment?: Readonly<Record<string, string>>) {
    // Coder v2.39.0 cli/ssh.go joins [command] with spaces before sending it to
    // the guest shell. Quote each argv, rather than passing lossy raw strings.
    return { executable: input.executable,
      args: ['ssh', ...(allowWake === false ? ['--disable-autostart'] : []), `${resource.ownerName}/${resource.workspaceName}.${resource.agentName}`, '--', ...argv.map(quote)],
      env: { CODER_URL: input.endpoint, CODER_SESSION_TOKEN: input.token, ...privateEnvironment } };
  }
  async function run(resource: CoderResource, argv: readonly string[], stdin?: Uint8Array, allowWake?: false, timeoutMs?: number | null, privateEnvironment?: Readonly<Record<string, string>>) {
    input.signal.throwIfAborted();
    return input.exec.run({ ...ssh(resource, argv, allowWake, privateEnvironment),
      ...(stdin === undefined ? {} : { stdin }), ...(timeoutMs === undefined || timeoutMs === null ? {} : { timeoutMs }),
    }, { signal: input.signal });
  }
  async function runWithGuestLifetime(resource: CoderResource, argv: readonly string[], stdin?: Uint8Array, allowWake?: false, timeoutMs?: number | null) {
    input.signal.throwIfAborted();
    const spawnProcess = input.exec.spawn!;
    const timeoutController = timeoutMs === undefined || timeoutMs === null ? null : new AbortController();
    let timedOut = false;
    const timer = timeoutController ? setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs!) : undefined;
    const spawnSignal = timeoutController ? AbortSignal.any([input.signal, timeoutController.signal]) : input.signal;
    const wrappedArgv = ['sh', '-c', guestCommandBootstrap, 'happier-exec', guestCommandLifetime, ...argv];
    let handle: Awaited<ReturnType<NonNullable<ExecService['spawn']>>> | undefined;
    try {
      handle = await spawnProcess(ssh(resource, wrappedArgv, allowWake), { signal: spawnSignal });
      try {
        await handle.write(Buffer.from(`${Buffer.from(stdin ?? []).toString('base64')}\n`));
      } catch (error) {
        if (input.signal.aborted) {
          await handle.wait().catch(() => undefined);
          throw new PluginError({ code: 'cancelled' });
        }
        throw error;
      }
      const result = await handle.wait();
      const { observed, requestedBy } = result.termination;
      if (input.signal.aborted && requestedBy.kind === 'abort' && (observed.kind === 'exit' || observed.kind === 'signal')) {
        throw new PluginError({ code: 'cancelled' });
      }
      if (timedOut && !input.signal.aborted && requestedBy.kind === 'abort') {
        return { ...result, termination: { ...result.termination, requestedBy: { kind: 'timeout' as const } } };
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await handle?.dispose();
    }
  }
  return {
    /** The optional `stream` role: one non-PTY `coder ssh` process carrying the invocation channel.
     * Its bytes are the guest command's own output (the holder's frames), never redacted. Coder may
     * keep the remote command running after this process ends: that is "state unknown", not exit. */
    async stream(value: Readonly<{ resource: CoderResource; argv: readonly string[] }>) {
      input.signal.throwIfAborted();
      if (!input.exec.spawn) throw new PluginError({ code: 'provider_unavailable', message: 'This host carries no native Coder channel' });
      // A channel never wakes a stopped workspace (`--disable-autostart`): power belongs to the reconciler.
      return input.exec.spawn(ssh(value.resource, value.argv, false), { signal: input.signal, outputDelivery: 'invocation' });
    },
    async exec(value: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
      const config = value.processConfig;
      // Go's serpent StringArray uses CSV. Alternate names avoid Coder agent's
      // HOME override; only a static wrapper and host argv enter local argv.
      const csv = (field: string) => /[",\r\n]/.test(field) ? '"' + field.replaceAll('"', '""') + '"' : field;
      const privateEnvironment = config ? { CODER_SSH_ENV: [
        `HAPPIER_CODER_HOME=${config.environment.HOME}`,
        `HAPPIER_CODER_STATE_HOME=${config.environment.HAPPIER_HOME_DIR}`,
      ].map(csv).join(',') } : undefined;
      const stdin = value.inputBase64 === undefined ? undefined : Buffer.from(value.inputBase64, 'base64');
      const argv = config ? ['sh', '-c', 'export HOME="$HAPPIER_CODER_HOME" HAPPIER_HOME_DIR="$HAPPIER_CODER_STATE_HOME"; unset HAPPIER_CODER_HOME HAPPIER_CODER_STATE_HOME; exec "$@"', 'sh', ...config.detachedDaemonStartArgv] : value.argv;
      const result = !config && input.exec.spawn
        ? await runWithGuestLifetime(value.resource, argv, stdin, value.allowWake, value.timeoutMs)
        : await run(value.resource, argv, stdin, value.allowWake, value.timeoutMs, privateEnvironment);
      if (config) {
        if (!isSuccessfulProcessResult(result)) throw new PluginError({ code: 'native_boot_unconfirmed' });
        return { kind: 'process-configured' };
      }
      return { termination: result.termination,
        stdoutBase64: redact(result.stdout, input.token).toString('base64'), stderrBase64: redact(result.stderr, input.token).toString('base64'),
        stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
    },
    async putFile(value: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>) {
      if (!value.guestPath.startsWith('/') || value.guestPath.includes('\0')) return { kind: 'refused' as const, code: 'invalid_request' };
      const command = `umask 077; cat > ${quote(value.guestPath)} && chmod ${(value.mode ?? 0o600).toString(8)} ${quote(value.guestPath)}`;
      const result = await run(value.resource, ['sh', '-c', command], Buffer.from(value.bytesBase64, 'base64'), value.allowWake);
      return isSuccessfulProcessResult(result) ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'provider_unavailable' };
    },
  };
}
