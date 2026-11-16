import { posix } from 'node:path';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import { buildBootstrapRootCommand, type ManagedNativeBootstrapIO } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { MachineEffectInternalRecordSchema, MachineEffectInternalRequestSchema } from './effectInternalProtocol';
import type { MachineSetupBoundTargetBasisV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupExclusionV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { selectMachineSetupRecipeItemsV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/machineSetupProjection';
import type { MachineEffectInternalRequest, MachineEffectInternalResult } from './effectInternalProtocol';
import { resolveMachineSetupRecipeProgramV1 } from './prepareMachineSetupPreparation';
import { applyMachineSetup, type ApplyMachineSetupInput, type BoundMachineSetupTarget } from './applyMachineSetup';

type BoundInterpreter = Readonly<{ transport: ManagedNativeBootstrapIO; binaryPath: string; operationId: string }>;

/** One transport/parser owner for native Check and Apply. */
async function invokeBoundMachineSetup(input: BoundInterpreter, request: MachineEffectInternalRequest, signal: AbortSignal,
  onProgress?: Parameters<NonNullable<BoundMachineSetupTarget['applyPlans']>>[2]): Promise<MachineEffectInternalResult> {
  signal.throwIfAborted();
  let result: MachineEffectInternalResult | undefined;
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
        if (record.type === 'progress') onProgress?.({ ...record, planIndex: record.planIndex ?? 0 });
        if (record.type === 'result') result = record.result;
      }
    } catch { invalidResponse = true; pending = ''; }
  };
  const response = await input.transport.exec({ command: buildBootstrapRootCommand([input.binaryPath, 'machine', 'effect-internal',
    `--operation-id=${input.operationId}`].map(safeBashSingleQuote).join(' ')),
    input: JSON.stringify(MachineEffectInternalRequestSchema.parse(request)) + '\n', signal,
    onStdoutChunk: chunk => { if (chunk) { streamed = true; consume(chunk); } } });
  if (!streamed) consume(response.stdout);
  if (pending.trim()) consume('\n');
  signal.throwIfAborted();
  if (invalidResponse || !result || response.status !== 0 && (result.status === 'applied' || result.status === 'checked')) {
    throw new SystemTaskExecutionError('machine_setup_apply_failed', 'The target Setup interpreter did not confirm its result.');
  }
  return result;
}

/** Resolve the admitted recipe copies once, then observe and compile them on the
 * target through the same native interpreter that will apply their plans. */
export async function prepareBoundMachineSetupRecipePlans(input: Omit<BoundInterpreter, 'operationId'> & Readonly<{
  basis: MachineSetupBoundTargetBasisV1;
  sources: readonly MachineSetupV1[];
  recipes: readonly Pick<PluginProjectedMachineRecipeEntryV1, 'pluginId' | 'definition'>[];
  exclusions?: readonly MachineSetupExclusionV1[];
  executionSources?: readonly MachineSetupV1[];
  signal: AbortSignal;
}>): Promise<NonNullable<ApplyMachineSetupInput['recipePlans']>> {
  input.signal.throwIfAborted();
  const selected = selectMachineSetupRecipeItemsV1(input.sources, input.exclusions ?? [], input.executionSources).filter(entry => entry.execute);
  if (!selected.length) return [];
  const recipes = selected.map(({ item }) => {
    const resolved = resolveMachineSetupRecipeProgramV1(item, input.recipes);
    if (!resolved.ok) throw new SystemTaskExecutionError(resolved.errorCode ?? 'machine_recipe_unavailable', resolved.error);
    return resolved.program;
  });
  const result = await invokeBoundMachineSetup({ ...input, operationId: input.basis.operationId }, { v: 1, mode: 'check', preparation: { basis: input.basis, recipes } }, input.signal);
  if (result.status !== 'checked') throw new SystemTaskExecutionError(result.reason ?? result.status, 'Target recipe Check did not complete.');
  if (!('plans' in result) || result.plans.length !== selected.length
    || result.plans.some(({ plan }) => !sameStrictJsonValue(plan.basis, input.basis))) {
    throw new SystemTaskExecutionError('plan_changed', 'Target recipe plans do not match the admitted association.');
  }
  return selected.map((entry, index) => ({ sourceIndex: entry.sourceIndex, itemIndex: entry.itemIndex, plan: result.plans[index]!.plan }));
}

/** Existing SSH/native bootstrap transports address POSIX guests. The supplied
 * transport is already bound to the controller-admitted resource and principal. */
export function createBoundMachineSetupTarget(input: Readonly<{
  transport: ManagedNativeBootstrapIO;
  administrator: boolean;
  /** Bootstrap plans carry their existing admission basis. The installed guest
   * interpreter needs only the originating operation's correlation id. */
  effectCli?: Readonly<{ binaryPath: string; operationId: string }>;
}>): BoundMachineSetupTarget {
  return {
    administrator: input.administrator,
    ...(input.effectCli ? { applyPlans: async (plans, signal, onProgress) => {
      const result = await invokeBoundMachineSetup({ transport: input.transport, ...input.effectCli! },
        { v: 1, mode: 'apply', plans: plans.map(plan => ({ plan })) }, signal, onProgress);
      if (result.status === 'checked') throw new SystemTaskExecutionError('machine_setup_apply_failed', 'Target returned Check instead of Apply.');
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
  'terminalSessions' | 'elevation' | 'boundTarget' | 'boundBasis' | 'machineId' | 'hostEnvironment' | 'platform' | 'nativeEffectContext'> & Readonly<{
    target: BoundMachineSetupTarget;
    controllerMachineId: string;
    basis: MachineSetupBoundTargetBasisV1;
    hostEnvironment: NodeJS.ProcessEnv;
    platform: 'linux' | 'darwin';
  }>): Promise<ActionExecuteResult> {
  return await applyMachineSetup({ ...input, machineId: input.controllerMachineId, managedId: input.basis.managedId, boundBasis: input.basis, boundTarget: input.target });
}
