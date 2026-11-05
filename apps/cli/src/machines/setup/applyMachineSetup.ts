import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionOperationDomainRefV1 } from '@happier-dev/protocol/actions/operations/v1';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import { createMachineSetupNativeBackend, applyMachineSetupEffectPlans, machineSetupPlansRequireAdministratorV1,
  runMachineSetupNativeCommand, type MachineSetupApplyResultV1 } from '@happier-dev/cli-common/machineSetup';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { mergeMachineSetupsV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { selectMachineSetupRecipeItemsV1,
  machineSetupItemKeyV1, projectMachineSetupSourceChangeExecutionV1,
  type MachineSetupExclusionV1, type MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { runElevatedEffect, type MachineElevationDependencies } from '../adminAccess/runElevatedEffect';
import { resolveMachineSetupNativeEffectKeys } from './machineSetupNativeEffects';
import { readMachineSetupSessionRefreshRequirement, describeMachineSetupSessionRefresh,
  type DaemonGroupRefreshNative } from '@/daemon/service/userManagerGroups';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import type { SecretReferenceOverlayEnvironmentInput } from '@/settings/secrets/secretReferenceOverlay';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { executeHostFiniteTerminalProcess } from '@/terminal/pty/finiteProcess';
import { resolveFiniteTerminalShell } from '@/terminal/pty/shells';
import { prepareProjectNativeToolchain, ProjectNativeToolchainUncertainError } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { resolveSecretReferenceOverlayEnvironment } from '@/settings/secrets/secretReferenceOverlay';
import type { TerminalPtyCustody } from '@/terminal/pty/sessions';
import { listMachineSetupAdaptersV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import { machineNativeEffectAdmission, MachineNativeEffectAdmissionError, type MachineNativeEffectContext, type MachineNativeEffectKey } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

export type ApplyMachineSetupInput = Readonly<{
  homeId: string;
  machineId: string;
  preset?: Readonly<{ id: string; revision: number }>;
  requesterAccountId: string;
  userHomeDirectory: string;
  /** Ordered admitted source copies; a single internal stage uses the same owner. */
  setup: MachineSetupV1 | MachineSetupV1[];
  recipePlans?: NonNullable<MachineSetupPlanResultV1['recipePlans']>;
  removalPlans?: NonNullable<MachineSetupPlanResultV1['removalPlans']>;
  exclusions?: readonly MachineSetupExclusionV1[];
  /** Captured by the receiving target, never supplied as caller authority. */
  sourceChange?: Readonly<{ currentSources: MachineSetupSourceV1; currentExclusions: readonly MachineSetupExclusionV1[]; sources: MachineSetupSourceV1 }>;
  elevation?: MachineElevationDependencies;
  groupRefreshNative?: DaemonGroupRefreshNative;
  operation: ProjectSetupOperationContext;
  terminalSessions: Pick<TerminalPtySessionManager, 'ensure' | 'waitForExit' | 'requestStop' | 'observeOutput'>;
  environmentIo: ProjectNativeToolchainIo;
  secretEnvironment?: Omit<SecretReferenceOverlayEnvironmentInput, 'secretReferenceOverlay'>;
  hostEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  managedId?: string;
  terminalCustody?: TerminalPtyCustody;
  signal?: AbortSignal;
  /** Nested host setup stages reuse their containing operation's full admission. */
  nativeEffectContext?: MachineNativeEffectContext;
  /** The service owner resolves reviewed ids to native project identities. */
  resolveSetupScriptServiceEffects?: (serviceIds: readonly string[]) => Promise<readonly MachineNativeEffectKey[]>;
  /** Existing native capture custody; receipt publication is outside this lifetime. */
  settleNative?: () => Promise<void>;
  /** Publish setup progress only after the complete native key set is admitted. */
  onAdmitted?: () => Promise<void>;
  /** Native first-presence belongs to the executor that observed it before mutation. */
  onSetupApplied?: (plans: readonly MachineSetupEffectPlanV1[], result: MachineSetupApplyResultV1) => void;
  isCurrent(): Promise<boolean>;
}>;
type AdmittedMachineSetupInput = Omit<ApplyMachineSetupInput, 'setup'> & Readonly<{
  setup: MachineSetupV1; sources: readonly MachineSetupV1[];
  plans: readonly MachineSetupEffectPlanV1[];
  taskKind: 'machine.setup.apply.v1' | 'machine.setup.remove.v1';
  emit?: MachineElevationDependencies['emit'];
}>;
/** Removal admits only declared plans; copied setup is never an effect operand. */
export type RemoveMachineSetupInput = Omit<ApplyMachineSetupInput, 'setup' | 'recipePlans' | 'removalPlans' | 'secretEnvironment' | 'sourceChange'> & Readonly<{
  plans: readonly MachineSetupEffectPlanV1[];
}>;

/** The native owner normalizes shared tools/refs once; script bodies remain separate. */
export function prepareMachineSetupStages(sources: readonly MachineSetupV1[], recipePlans?: NonNullable<MachineSetupPlanResultV1['recipePlans']>,
  exclusions: readonly MachineSetupExclusionV1[] = [], sourceChange?: ApplyMachineSetupInput['sourceChange']):
  Readonly<{ ok: true; setup: MachineSetupV1; sources: readonly MachineSetupV1[] }> | ActionExecuteFailure {
  const merged = mergeMachineSetupsV1(sources);
  if (!merged.ok) return merged;
  if (recipePlans?.some(entry => {
    const item = sources[entry.sourceIndex]?.items?.[entry.itemIndex];
    return !item || item.kind === 'app' || entry.plan.basis.kind !== 'setup'
      || !sameStrictJsonValue(entry.plan.basis.selection, item.selection);
  })) return { ok: false, errorCode: 'plan_changed', error: 'plan_changed' };
  if (sourceChange && !sameStrictJsonValue(sourceChange.sources.map(source => source.setup), sources)) return {
    ok: false, errorCode: 'plan_changed', error: 'plan_changed',
  };
  const execution = sourceChange ? projectMachineSetupSourceChangeExecutionV1(sourceChange.currentSources,
    sourceChange.sources, merged.setup, sourceChange.currentExclusions) : { ok: true as const, setup: merged.setup, sources };
  if (!execution.ok) return execution;
  if (recipePlans === undefined && sources.some(setup => setup.items?.length)) return {
    ok: false, errorCode: 'machine_setup_items_unsupported', error: 'machine_setup_items_unsupported',
  };
  const recipeItems = selectMachineSetupRecipeItemsV1(sources, exclusions,
    sourceChange ? execution.sources : undefined).filter(entry => entry.execute);
  if (recipePlans) {
    if (recipeItems.length !== recipePlans.length || recipeItems.some((item, index) => {
      const entry = recipePlans[index];
      return !entry || entry.sourceIndex !== item.sourceIndex || entry.itemIndex !== item.itemIndex
        || entry.plan.basis.kind !== 'setup' || !sameStrictJsonValue(entry.plan.basis.selection, item.item.selection);
    })) return { ok: false, errorCode: 'plan_changed', error: 'plan_changed' };
  }
  if (execution.sources.some(setup => setup.scripts?.some(script => script.body && script.check?.requiredFacts?.length))) return {
    ok: false, errorCode: 'machine_setup_script_check_unsupported', error: 'machine_setup_script_check_unsupported',
  };
  const selectedKeys = new Set(recipeItems.map(entry => machineSetupItemKeyV1(entry.item)));
  return { ok: true, setup: execution.setup.items === undefined ? execution.setup : { ...execution.setup,
    items: execution.setup.items.filter(item => item.kind === 'app' || selectedKeys.has(machineSetupItemKeyV1(item))),
  }, sources: execution.sources };
}

export async function applyMachineSetup(input: ApplyMachineSetupInput,
  prepared = prepareMachineSetupStages(Array.isArray(input.setup) ? input.setup : [input.setup], input.recipePlans, input.exclusions, input.sourceChange)): Promise<ActionExecuteResult> {
  if (!prepared.ok) return prepared;
  const plans = [...(input.removalPlans ?? []).map(entry => entry.plan), ...(input.recipePlans ?? []).map(entry => entry.plan)];
  if (plans.some(plan => plan.basis.kind !== 'setup' || plan.basis.machineId !== input.machineId)) {
    return { ok: false, errorCode: 'plan_changed', error: 'plan_changed' };
  }
  return await startMachineSetup({ ...input, setup: prepared.setup, sources: prepared.sources, plans, taskKind: 'machine.setup.apply.v1' });
}

export async function removeMachineSetup(input: RemoveMachineSetupInput): Promise<ActionExecuteResult> {
  if (input.plans.some(plan => plan.basis.kind !== 'setup' || plan.basis.machineId !== input.machineId)) {
    return { ok: false, errorCode: 'plan_changed', error: 'plan_changed' };
  }
  return await startMachineSetup({ ...input, setup: {}, sources: [], taskKind: 'machine.setup.remove.v1' });
}

export async function applyMachineSetupUpdates(input: Omit<ApplyMachineSetupInput,
  'setup' | 'recipePlans' | 'removalPlans' | 'exclusions' | 'sourceChange' | 'secretEnvironment' | 'preset' | 'managedId'> & Readonly<{
    plan: MachineSetupEffectPlanV1;
  }>): Promise<ActionExecuteResult> {
  return await startMachineSetup({ ...input, setup: {}, sources: [], plans: [input.plan], taskKind: 'machine.setup.apply.v1' });
}

async function startMachineSetup(input: AdmittedMachineSetupInput): Promise<ActionExecuteResult> {
  const signal = input.signal ?? input.operation.signal;
  const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
  if (signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  if (!operationId) return { ok: false, errorCode: 'machine_setup_operation_unavailable', error: 'machine_setup_operation_unavailable' };
  const owner = getLiveSystemTasksRunnerAdapter();
  const taskKind = input.taskKind;
  let setupTask: Readonly<{ id: string; taskKind: typeof taskKind }> | undefined;
  let attachment: Extract<ActionOperationDomainRefV1, { kind: 'machineSetup' }> = {
    kind: 'machineSetup', serverId: input.homeId, machineId: input.machineId,
    ...(input.preset ? { preset: input.preset } : {}), ...(input.managedId ? { managedId: input.managedId } : {}),
  };
  const operation = { ...input.operation, operationOwnerUpdate: {
    update: (update: Parameters<ProjectSetupOperationContext['operationOwnerUpdate']['update']>[0]) => {
      if (update.domainRef?.kind !== 'machineSetup') { input.operation.operationOwnerUpdate.update(update); return; }
      attachment = { ...update.domainRef, ...(setupTask ? { setupTask } : {}) };
      input.operation.operationOwnerUpdate.update({ ...update, domainRef: attachment });
    },
  } };
  let outcome: ActionExecuteResult | undefined;
  const task = await owner.startAdmitted({ run: async context => {
    const result = await applyMachineSetupWithNativeAdmission({ ...input, operation,
      emit: context.emit,
      ...(input.elevation ? { elevation: { ...input.elevation, prompt: context.prompt, emit: context.emit } } : {}),
      signal: context.signal ? AbortSignal.any([signal, context.signal]) : signal });
    outcome = result;
    if (!result.ok) throw new SystemTaskExecutionError(result.errorCode ?? 'machine_setup_apply_failed', result.error);
    return { operationId };
  } }, taskKind);
  setupTask = { id: task.taskId, taskKind };
  attachment = { ...attachment, setupTask };
  input.operation.operationOwnerUpdate.update({ domainRef: attachment });
  const cancel = () => { void owner.cancel(task); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const settled = await owner.wait(task);
    return outcome ?? (settled.ok
      ? { ok: false, errorCode: 'machine_setup_apply_failed', error: 'machine_setup_apply_failed' }
      : { ok: false, errorCode: settled.error.code, error: settled.error.message });
  } finally { signal.removeEventListener('abort', cancel); }
}

async function applyMachineSetupWithNativeAdmission(input: AdmittedMachineSetupInput): Promise<ActionExecuteResult> {
  const signal = input.signal ?? input.operation.signal;
  const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
  if (signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  if (!operationId) return { ok: false, errorCode: 'machine_setup_operation_unavailable', error: 'machine_setup_operation_unavailable' };
  try {
    const keys = await resolveMachineSetupNativeEffectKeys({ ...input, signal,
      ...(input.setup.scripts ? { scripts: input.setup.scripts } : {}) });
    const execute = async (context: MachineNativeEffectContext) => {
      try {
        await input.onAdmitted?.();
        const result = await machineNativeEffectAdmission.runStage(context, () => applyAdmittedMachineSetup(input));
        if (!result.ok && (result.errorCode === 'outcome_uncertain' || result.errorCode === 'outcome_unknown' || result.errorCode === 'stop_unconfirmed')) {
          machineNativeEffectAdmission.markUnsettled(context);
        }
        return result;
      } catch (error) {
        if (error instanceof ProjectNativeToolchainUncertainError
          || error && typeof error === 'object' && 'code' in error && error.code === 'plugin_exec_termination_incomplete') {
          machineNativeEffectAdmission.markUnsettled(context);
        }
        throw error;
      }
    };
    if (input.nativeEffectContext) {
      if (input.nativeEffectContext.operation.operationId !== operationId) throw new MachineNativeEffectAdmissionError('admission_unavailable');
      return await execute(input.nativeEffectContext);
    }
    return await machineNativeEffectAdmission.run({ operation: { operationId, kind: 'machine_setup', signal }, keys,
      ...(input.settleNative ? { settleNative: input.settleNative } : {}) }, execute);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : signal.aborted ? 'cancelled' : 'machine_setup_apply_failed';
    return { ok: false, errorCode: code, error: error instanceof MachineNativeEffectAdmissionError ? error.message : code,
      ...(error instanceof MachineNativeEffectAdmissionError && error.details ? { details: error.details } : {}) };
  }
}

async function applyAdmittedMachineSetup(input: AdmittedMachineSetupInput): Promise<ActionExecuteResult> {
  const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
  const platform = input.platform ?? process.platform;
  const signal = input.signal ?? input.operation.signal;
  const isCurrent = async () => !signal.aborted && await input.isCurrent() && !signal.aborted;
  const retired = () => fail(signal.aborted ? 'cancelled' : 'machine_admission_changed');
  const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
  if (signal.aborted) return fail('cancelled');
  if (!operationId || !input.requesterAccountId) return fail('machine_setup_operation_unavailable');
  if (!await isCurrent()) return retired();
  const hostEnv = Object.fromEntries(Object.entries(input.hostEnvironment ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const attachment = { kind: 'machineSetup' as const, serverId: input.homeId, machineId: input.machineId,
    ...(input.preset ? { preset: input.preset } : {}), ...(input.managedId ? { managedId: input.managedId } : {}) };
  input.operation.operationOwnerUpdate.update({ domainRef: attachment });
  if (input.plans.length) {
    const plans = input.plans.map(plan => ({ plan }));
    let daemonRestartRequired = false;
    if (machineSetupPlansRequireAdministratorV1(input.plans)) {
      if (!input.elevation) return fail('admin_access_unavailable');
      const elevated = await runElevatedEffect({ machineId: input.machineId, operationId, signal,
        effect: { kind: 'setupOperation', plans },
        onSetupApplied: result => { daemonRestartRequired = result.daemonRestartRequired;
          input.onSetupApplied?.(input.plans, result); },
      }, input.elevation);
      if (elevated.outcome !== 'applied') {
        const code = elevated.outcome === 'not_applied'
          ? elevated.reasonCode === 'plan_stale' ? 'plan_changed' : elevated.reasonCode : elevated.outcome;
        return { ok: false, errorCode: code, error: code,
          ...('failure' in elevated && elevated.failure
            ? { details: { kind: 'machineSetup', failure: elevated.failure } } : {}) };
      }
    } else {
      const result = await applyMachineSetupEffectPlans({ plans, signal,
        backend: createMachineSetupNativeBackend({ signal, run: async command => {
          signal.throwIfAborted();
          return runMachineSetupNativeCommand(command);
        } }),
        onProgress: event => input.emit?.({ type: 'machine.setup.progress', stepId: event.stepId,
          data: { phase: event.phase, status: event.status, planIndex: event.planIndex,
            ...(event.reason ? { reason: event.reason } : {}) } }),
      });
      input.emit?.({ type: 'machine.setup.result', data: result });
      daemonRestartRequired = result.daemonRestartRequired;
      if (result.status === 'applied') input.onSetupApplied?.(input.plans, result);
      if (result.status !== 'applied') {
        if (signal.aborted) return fail('cancelled');
        const code = result.status === 'plan_changed' ? 'plan_changed' : result.failure?.kind ?? result.reason ?? result.status;
        return { ok: false, errorCode: code, error: code,
          ...(result.failure ? { details: { kind: 'machineSetup', failure: result.failure } } : {}) };
      }
    }
    if (signal.aborted) return fail('cancelled');
    const requiredStep = await readMachineSetupSessionRefreshRequirement(input.plans, input.groupRefreshNative, daemonRestartRequired);
    if (requiredStep) return { ok: false, errorCode: 'requires_session_refresh',
      error: describeMachineSetupSessionRefresh(requiredStep), details: { requiredStep } };
  }
  let terminalId: string | undefined;
  const terminals: { install?: string; setup?: string } = {};
  let env: Readonly<Record<string, string>> = hostEnv;
  const run = async (phase: string, command: string, args: readonly string[], launchEnv: Readonly<Record<string, string>>, failureCode: string, stage = '') => {
    if (signal.aborted) return fail('cancelled');
    const outcome = await executeHostFiniteTerminalProcess({ operation: input.operation, terminalSessions: input.terminalSessions,
      requesterAccountId: input.requesterAccountId, terminalCustody: input.terminalCustody,
      signal,
      terminalKey: `${operationId}:machineSetup:${phase}${stage}`, launch: { command, args, cwd: input.userHomeDirectory, env: launchEnv },
      progress: { phase, label: phase === 'install' ? 'Installing machine tools' : 'Setting up machine' }, failureCode,
      attachment: observation => {
        if (phase === 'install' || phase === 'setup') terminals[phase] = observation.terminalId;
        return { ...attachment, ...observation, terminals: { ...terminals } };
      } });
    terminalId = outcome.terminalId;
    return outcome.result;
  };
  const toolchain = input.setup.toolchain;
  if (toolchain) {
    // Consumes the exact builtin B3 contract, not a guessed adapter command.
    const adapter = listMachineSetupAdaptersV1(platform).find(candidate => candidate.id === toolchain.adapterId);
    if (!adapter) return fail('native_adapter_not_characterized');
    const tool = await input.environmentIo.resolveTool(adapter.id, signal);
    if (signal.aborted) return fail('cancelled');
    if (!tool) return fail('native_tool_unavailable');
    if (tool.version !== adapter.nativeVersion) return fail('native_version_not_characterized');
    // Mise v2026.10.4 crates/mise-util/src/env.rs (reexported by src/env.rs):
    // GLOBAL_CONFIG_FILE > CONFIG_FILE > CONFIG_DIR > XDG_CONFIG_HOME.
    const configured = hostEnv.MISE_GLOBAL_CONFIG_FILE || hostEnv.MISE_CONFIG_FILE;
    const configDirectory = hostEnv.MISE_CONFIG_DIR || join(hostEnv.XDG_CONFIG_HOME || join(input.userHomeDirectory, '.config'), 'mise');
    const configPath = resolve(input.userHomeDirectory, expandHomeDirPath(configured || join(configDirectory, adapter.globalEnvironment.configFile), hostEnv, platform));
    try {
      await mkdir(dirname(configPath), { recursive: true });
      if (signal.aborted) return fail('cancelled');
      await writeFile(configPath, toolchain.config, 'utf8');
    }
    catch { return fail('machine_setup_configuration_failed'); }
    if (signal.aborted) return fail('cancelled');
    const installed = await run('install', tool.executablePath, [...(tool.args ?? []), ...adapter.globalEnvironment.installArgs],
      { ...hostEnv, MISE_OVERRIDE_CONFIG_FILENAMES: configPath }, 'machine_setup_install_failed');
    if (!installed.ok) return installed;
    if (signal.aborted) return fail('cancelled');
    const produced = await prepareProjectNativeToolchain({ selection: { kind: 'toolchain', tool: adapter.id, configPath: basename(configPath) },
      root: dirname(configPath), cwd: input.userHomeDirectory, env: hostEnv, platform, signal,
      io: { ...input.environmentIo, run: async request => {
        signal.throwIfAborted();
        return input.environmentIo.run(request);
      } } });
    if (signal.aborted) return fail('cancelled');
    if (produced.status !== 'ready') return fail(produced.kind === 'cancelled' ? 'cancelled' : produced.code);
    env = produced.env;
  }
  if (signal.aborted) return fail('cancelled');
  let scriptIndex = 0;
  for (const source of input.sources) for (const script of source.scripts ?? []) {
    const index = scriptIndex++;
    if (!script.body) continue;
    let secretEnv: Readonly<Record<string, string>> = {};
    if (source.secretRefs) {
      if (!input.secretEnvironment) return fail('saved_secret_unavailable');
      try { secretEnv = resolveSecretReferenceOverlayEnvironment({ ...input.secretEnvironment, secretReferenceOverlay: source.secretRefs }); }
      catch { return fail('saved_secret_unavailable'); }
    }
    const scriptEnvironment = { ...env, ...secretEnv };
    const check = script.check;
    const backend = check ? createMachineSetupNativeBackend({ signal, run: async command => {
      signal.throwIfAborted();
      const result = await input.environmentIo.run({ command: command.executable, args: command.args,
        cwd: input.userHomeDirectory, env: { ...scriptEnvironment, ...command.env }, signal });
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
    } }) : undefined;
    // Synthesize the existing checked-command arm without changing stored body
    // bytes or running them in the elevated/native command interpreter.
    const observe = check && backend ? () => backend.observe({ id: 'setupScript', kind: 'command',
      executable: check.executable, args: check.args,
      check: { executable: check.executable, args: check.args, unsatisfiedExitCodes: check.unsatisfiedExitCodes },
    }) : undefined;
    if (observe) {
      const observed = await observe();
      if (signal.aborted) return fail('cancelled');
      if (observed.status === 'satisfied') continue;
      if (observed.status !== 'drifted') return fail('machine_setup_script_check_unavailable');
    }
    const shell = resolveFiniteTerminalShell(script.body, hostEnv, platform);
    const setup = await run('setup', shell.file, shell.args, scriptEnvironment, 'machine_setup_setup_failed', `:${index}`);
    if (!setup.ok) return setup;
    if (observe) {
      const verified = await observe();
      if (signal.aborted) return fail('cancelled');
      if (verified.status !== 'satisfied') return fail(verified.status === 'drifted'
        ? 'machine_setup_script_check_failed' : 'machine_setup_script_check_unavailable');
    }
  }
  return { ok: true, result: { operationId, ...(terminalId ? { terminalId } : {}) } };
}
