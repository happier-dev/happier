import type { LimaCommandResult, LimaExecutor } from '@happier-dev/cli-common/machineLima';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

export type LimaProcessCommandResult = LimaCommandResult & Readonly<{ process: PluginProcessResult }>;

/** The public, invocation-owned process service is the only Lima process boundary. */
export function createLimaSdkExecutor({ exec, executable, signal }: Readonly<{
  exec: Pick<ExecService, 'run'>; executable: ManagedExecutableRef; signal: AbortSignal;
}>): LimaExecutor<LimaProcessCommandResult> {
  const capture: LimaExecutor<LimaProcessCommandResult>['capture'] = async (command, args, options) => {
    if (command !== 'limactl') throw new Error('Lima executor accepts only its declared executable');
    const process = await exec.run({
      executable, args, ...(options?.env ? { env: options.env } : {}),
      ...(options?.input === undefined ? {} : { stdin: typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input }),
    }, { signal, ...(args[0] === 'shell' ? { outputDelivery: 'invocation' as const } : {}) });
    if ((args[0] === 'list' || args[0] === '--version' || args[0] === 'info') && (process.stdoutTruncated || process.stderrTruncated)) {
      throw Object.assign(new Error('native Lima observation is incomplete'), { code: 'LIMA_INSPECT_UNAVAILABLE' });
    }
    const observed = process.termination.observed;
    return {
      exitCode: observed.kind === 'exit' && process.termination.requestedBy.kind === 'none' ? observed.exitCode : null,
      out: new TextDecoder().decode(process.stdout), err: new TextDecoder().decode(process.stderr), process,
    };
  };
  return { capture, run: capture };
}
