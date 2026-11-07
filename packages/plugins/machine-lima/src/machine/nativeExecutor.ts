import type { LimaCommandResult, LimaExecutor } from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectPluginFailureText } from '@happier-dev/plugin-sdk';
import { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export type LimaProcessCommandResult = LimaCommandResult & Readonly<{ process: PluginProcessResult }>;

export class LimaNativeCommandError extends PluginError {
  constructor(readonly nativeCause: Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }>) {
    super({ code: nativeCause.command === 'stop' ? 'lima_stop_failed' : 'lima_start_failed', details: { nativeCause } });
  }
}

/** The public, invocation-owned process service is the only Lima process boundary. */
export function createLimaSdkExecutor({ exec, executable, signal }: Readonly<{
  exec: Pick<ExecService, 'run'>; executable: ManagedExecutableRef; signal: AbortSignal;
}>): LimaExecutor<LimaProcessCommandResult> {
  const capture: LimaExecutor<LimaProcessCommandResult>['capture'] = async (_command, args, options) => {
    const process = await exec.run({
      executable, args, ...(options?.env ? { env: options.env } : {}),
      ...(options?.input === undefined ? {} : { stdin: typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input }),
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
    if ((command === 'start' || command === 'restart' || command === 'stop') && exitCode !== 0) {
      // Project the whole retained stderr before truncating, so a credential
      // crossing the excerpt boundary cannot leak a partial value.
      const err = new TextDecoder().decode(process.stderr).trim();
      const projected = err ? projectPluginFailureText(new Error(err)) : '';
      const truncated = process.stderrTruncated || projected.length > MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1;
      throw new LimaNativeCommandError({ localCause: 'native_command_failed', command, exitCode,
          ...(projected ? { stderr: projected.slice(-MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1) } : {}),
          ...(truncated ? { stderrTruncated: true } : {}),
      });
    }
    return {
      exitCode,
      out: new TextDecoder().decode(process.stdout), err: new TextDecoder().decode(process.stderr), process,
    };
  };
  return { capture, run: capture };
}
