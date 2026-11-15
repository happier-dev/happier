import { posix } from 'node:path';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { ManagedNativeBootstrapIO } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { MachineEffectInternalRecordSchema, MachineEffectInternalRequestSchema } from './effectInternalProtocol';
import type { MachineSetupApplyResultV1 } from '@happier-dev/cli-common/machineSetup';
import { applyMachineSetup, type ApplyMachineSetupInput, type BoundMachineSetupTarget } from './applyMachineSetup';

/** Existing SSH/native bootstrap transports address POSIX guests. The supplied
 * transport is already bound to the controller-admitted resource and principal. */
export function createBoundMachineSetupTarget(input: Readonly<{
  transport: ManagedNativeBootstrapIO;
  administrator: boolean;
  /** Existing effect-internal invocation identity, obtained from the installed
   * guest CLI. This does not require pairing/enrolling a Machine. The controller
   * supplies its already selected privileged transport separately from scripts. */
  effectCli?: Readonly<{ binaryPath: string; installationId: string; machineId: string; operationId: string;
    transport: ManagedNativeBootstrapIO; daemonUsername?: string;
    daemonExecutionContext?: Readonly<{ home: string; path: string }> }>;
}>): BoundMachineSetupTarget {
  return {
    administrator: input.administrator,
    ...(input.effectCli ? { applyPlans: async (plans, signal, onProgress) => {
      const cli = input.effectCli!;
      const request = MachineEffectInternalRequestSchema.parse({ v: 1, mode: 'apply',
        machineId: cli.machineId, installationId: cli.installationId, operationId: cli.operationId,
        ...(cli.daemonUsername ? { daemonUsername: cli.daemonUsername } : {}),
        ...(cli.daemonExecutionContext ? { daemonExecutionContext: cli.daemonExecutionContext } : {}),
        plans: plans.map(plan => ({ plan })) });
      let result: MachineSetupApplyResultV1 | undefined;
      let pending = '';
      let streamed = false;
      let invalidResponse = false;
      const consume = (chunk: string) => {
        if (invalidResponse) return;
        pending += chunk;
        try {
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            if (result) throw new Error('Record after terminal result');
            const record = MachineEffectInternalRecordSchema.parse(JSON.parse(line));
            if (record.type === 'progress') onProgress({ ...record, planIndex: record.planIndex ?? 0 });
            if (record.type === 'result' && record.result.status !== 'checked') result = record.result;
          }
        } catch { invalidResponse = true; pending = ''; }
      };
      const response = await cli.transport.exec({ command: [cli.binaryPath, 'machine', 'effect-internal',
        `--operation-id=${cli.operationId}`, `--installation-id=${cli.installationId}`].map(safeBashSingleQuote).join(' '),
        input: JSON.stringify(request) + '\n', signal,
        onStdoutChunk: chunk => { if (chunk) { streamed = true; consume(chunk); } } });
      if (!streamed) consume(response.stdout);
      if (pending.trim()) consume('\n');
      if (invalidResponse || !result || response.status !== 0 && result.status === 'applied') throw new SystemTaskExecutionError(
        'machine_setup_apply_failed', 'The target Setup interpreter did not confirm its result.');
      return result;
    } } satisfies Pick<BoundMachineSetupTarget, 'applyPlans'> : {}),
    async run(request) {
      request.signal?.throwIfAborted();
      const command = `cd ${safeBashSingleQuote(request.cwd)} && exec env ${[
        ...Object.entries(request.env).map(([key, value]) => `${key}=${value}`), request.command, ...request.args,
      ].map(safeBashSingleQuote).join(' ')}`;
      const result = await input.transport.exec({ command, signal: request.signal,
        ...(request.stdin ? { input: Buffer.from(request.stdin).toString('utf8') } : {}) });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    async writeConfiguration(path, content, signal) {
      signal.throwIfAborted();
      const directory = await input.transport.exec({ command: `mkdir -p -- ${safeBashSingleQuote(posix.dirname(path))}`, signal });
      if (directory.status !== 0) throw new SystemTaskExecutionError('machine_setup_configuration_failed', 'Target configuration directory could not be created.');
      signal.throwIfAborted();
      await input.transport.putFile({ path, bytes: Buffer.from(content, 'utf8'), signal });
    },
  };
}

/** Bound setup is a nested stage of the admitted acquire, with no enrollment,
 * local terminal requirement, host filesystem writes or host process fallback. */
export async function applyBoundMachineSetup(input: Omit<ApplyMachineSetupInput,
  'terminalSessions' | 'elevation' | 'boundTarget' | 'hostEnvironment' | 'platform' | 'nativeEffectContext'> & Readonly<{
    target: BoundMachineSetupTarget;
    hostEnvironment: NodeJS.ProcessEnv;
    platform: 'linux' | 'darwin';
  }>): Promise<ActionExecuteResult> {
  return await applyMachineSetup({ ...input, boundTarget: input.target });
}
