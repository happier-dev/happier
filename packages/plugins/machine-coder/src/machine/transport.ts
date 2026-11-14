import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { MachineProvisionerNativeExecResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { CoderResource, ROLE_SCHEMAS } from './schemas.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const completed = (result: PluginProcessResult) => result.termination.requestedBy.kind === 'none'
  && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
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

/** Finite native Coder SSH only. Shared enrollment owns pairing and daemon
 * lifecycle. Cancellation closes this invocation; Coder may leave remote work. */
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
      const argv = config ? ['sh', '-c', 'export HOME="$HAPPIER_CODER_HOME" HAPPIER_HOME_DIR="$HAPPIER_CODER_STATE_HOME"; unset HAPPIER_CODER_HOME HAPPIER_CODER_STATE_HOME; exec "$@"', 'sh', ...config.detachedDaemonStartArgv] : value.argv;
      const result = await run(value.resource, argv, value.inputBase64 === undefined ? undefined : Buffer.from(value.inputBase64, 'base64'), value.allowWake, value.timeoutMs, privateEnvironment);
      if (config) {
        if (!completed(result)) throw new PluginError({ code: 'native_boot_unconfirmed' });
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
      return completed(result) ? { kind: 'confirmed' as const } : { kind: 'unknown' as const, code: 'provider_unavailable' };
    },
  };
}
