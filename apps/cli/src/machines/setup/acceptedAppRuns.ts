import { DeploymentTemplateInstantiateResultV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import {
  MachineSetupApplyInputV1Schema,
  type MachineSetupApplyTargetV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import {
  machineSetupSourceOriginKeyV1,
  type MachineSetupAcceptedAppRunV1,
  type MachineSetupSourceFactsMapV1,
} from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { StoredAppPresetInputV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { readMachineSetupAppIdentityV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { DeploymentReceiptResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  WorkflowRunGetResultV1Schema, WorkflowInvocationListResultV1Schema,
  type WorkflowRunGetResultV1,
} from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowInvocationDetailV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { readWorkflowInvocationRootV1, readWorkflowInvocationMembersV1,
  readWorkflowCurrentInvocationAncestryV1, resolveWorkflowInvocationStructureV1 } from '@happier-dev/protocol/workflows';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { prepareActionCompletionV1 } from '@happier-dev/protocol/actions/actionCompletion';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

type App = Readonly<{ intent: StoredAppPresetInputV1; authoredKey?: string; reference?: MachineSetupAcceptedAppRunV1 }>;
type Outcome = Readonly<{ kind: 'completed' | 'not_completed' | 'failed' | 'unknown' }>;
export type MachineSetupAcceptedAppRunObservation = App & Readonly<{ outcome: Outcome; environmentId?: string }>;
type AcceptedBinding = Readonly<{ reference: MachineSetupAcceptedAppRunV1; environmentId?: string }>;
type ReadRuntime = Readonly<{
  homeId: string;
  machineId: string;
  execute: ReturnType<typeof createActionExecutor>['execute'];
  isCurrent(): Promise<boolean>;
  signal?: AbortSignal;
}>;

function accountReadContext(runtime: ReadRuntime): ActionExecutorContext {
  return { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
    serverIdentityId: runtime.homeId, ...(runtime.signal ? { signal: runtime.signal } : {}) };
}

async function readAccepted(runtime: ReadRuntime, runId: string): Promise<WorkflowRunGetResultV1 | undefined> {
  if (runtime.signal?.aborted || !await runtime.isCurrent()) return undefined;
  const response = await runtime.execute('workflow.run.get', { runId, includeUsage: false }, accountReadContext(runtime));
  if (!response.ok || runtime.signal?.aborted || !await runtime.isCurrent()) return undefined;
  const parsed = WorkflowRunGetResultV1Schema.safeParse(response.result);
  return parsed.success && parsed.data.run.id === runId ? parsed.data : undefined;
}

/** The combined setup producer emits singleton native leaves, not another parent envelope. */
function nativeTargets(run: WorkflowRunGetResultV1, homeId: string, machineId: string): MachineSetupApplyTargetV1[] {
  return run.acceptedContext.materializedLeaves.flatMap(leaf => {
    if (leaf.kind !== 'action' || leaf.actionId !== 'machines.setup.apply') return [];
    const parsed = MachineSetupApplyInputV1Schema.safeParse(leaf.actionInput);
    if (!parsed.success || parsed.data.homeId !== homeId || parsed.data.machineId !== machineId
      || parsed.data.targets.length !== 1) return [];
    const target = parsed.data.targets[0]!;
    return target.homeId === homeId && target.machineId === machineId ? [target] : [];
  });
}

/** Associations are accepted bytes, never reconstructed app-{sourceIndex}-{itemIndex} addresses. */
function acceptedBinding(run: WorkflowRunGetResultV1, targets: readonly MachineSetupApplyTargetV1[], homeId: string,
  app: App, exactTarget?: MachineSetupApplyTargetV1): AcceptedBinding | undefined {
  const identity = readMachineSetupAppIdentityV1({ kind: 'app', definition: app.intent,
    ...(app.authoredKey === undefined ? {} : { authoredKey: app.authoredKey }) });
  if (identity === undefined) return undefined;
  const candidates: AcceptedBinding[] = [];
  for (const target of targets) {
    if (exactTarget && !sameStrictJsonValue(target, exactTarget)) continue;
    for (const child of target.appChildren ?? []) {
      if (child.actionId !== 'deployments.deploy' && child.actionId !== 'deployments.templates.instantiate') continue;
      const item = target.sources[child.sourceIndex]?.setup.items?.[child.itemIndex];
      if (item?.kind !== 'app' || readMachineSetupAppIdentityV1(item) !== identity) continue;
      const matches = run.acceptedContext.materializedLeaves.filter(leaf => leaf.kind === 'action'
        && leaf.actionId === child.actionId && sameStrictJsonValue(leaf.actionInput, child.input));
      if (matches.length !== 1) return undefined;
      const leaf = matches[0]!;
      // Current setup compositions are flat inline definitions. Other structures
      // are unreadable here rather than guessed from positions or a Run summary.
      if (leaf.sourceKey !== '$root') return undefined;
      const reference = { intent: item.definition, ...(item.authoredKey === undefined ? {} : { authoredKey: item.authoredKey }),
        homeId, runId: run.run.id,
        sourceKey: leaf.sourceKey, blockId: leaf.blockId, actionId: child.actionId };
      const environmentId = child.actionId === 'deployments.deploy' ? child.input.environmentId
        : child.input.environment.kind === 'existing' ? child.input.environment.environmentId : undefined;
      if (!app.reference || sameStrictJsonValue(reference, app.reference)) candidates.push({ reference,
        ...(environmentId === undefined ? {} : { environmentId }) });
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Authenticate before physical effects; native settlement alone publishes.
 * The canonical desired-state CAS retains incumbent same-origin app facts.
 */
export async function prepareMachineSetupAcceptedAppRuns(params: Readonly<{
  input: MachineSetupApplyTargetV1;
  context: RpcActionExecutorContext;
  isCurrent(): Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<MachineSetupSourceFactsMapV1 | null> {
  const facts: MachineSetupSourceFactsMapV1 = {};
  if (!params.input.appChildren?.length) return facts;
  const authorization = params.context.externalActionExecutionAuthorization;
  const account = authorization?.requesterAccountProjection;
  const executor = authorization?.requesterAccountExecutor;
  const runId = authorization?.binding.workflowActionOrigin?.runId;
  if (!authorization || !account || !executor || !runId
    || authorization.binding.actionId !== 'machines.setup.apply'
    || authorization.binding.serverIdentityId !== params.input.homeId
    || authorization.binding.machineId !== params.input.machineId
    || account.accountId !== authorization.binding.accountId) return null;
  const runtime: ReadRuntime = { homeId: params.input.homeId, machineId: params.input.machineId,
    execute: (actionId, input, context) => executor.execute(actionId, input, context),
    isCurrent: params.isCurrent,
    ...(params.signal ? { signal: params.signal } : {}) };
  try {
    const run = await readAccepted(runtime, runId);
    if (!run) return null;
    const targets = nativeTargets(run, runtime.homeId, runtime.machineId);
    // One authenticated Run read covers every reviewed app in this settlement.
    // Native stage preparation already rejects duplicate canonical app intents.
    for (const child of params.input.appChildren) {
      const item = params.input.sources[child.sourceIndex]?.setup.items?.[child.itemIndex];
      if (item?.kind !== 'app') return null;
      const binding = acceptedBinding(run, targets, runtime.homeId, { intent: item.definition,
        ...(item.authoredKey === undefined ? {} : { authoredKey: item.authoredKey }) }, params.input);
      const reference = binding?.reference;
      if (!reference || reference.actionId !== child.actionId) return null;
      const source = params.input.sources[child.sourceIndex];
      if (!source) return null;
      const origin = machineSetupSourceOriginKeyV1(source);
      const prior = facts[origin]?.acceptedAppRuns ?? [];
      facts[origin] = { acceptedAppRuns: [...prior, reference] };
    }
    return params.signal?.aborted || !await runtime.isCurrent() ? null : facts;
  } catch {
    return null;
  }
}

function settledOutcome(row: WorkflowInvocationDetailV1, reference: MachineSetupAcceptedAppRunV1,
  boundEnvironmentId: string | undefined): Pick<MachineSetupAcceptedAppRunObservation, 'outcome' | 'environmentId'> {
  let environmentId = boundEnvironmentId;
  let result = row.progress.result;
  const observation = (kind: Outcome['kind']) => ({ outcome: { kind }, ...(environmentId === undefined ? {} : { environmentId }) });
  const lifecycleOutcome: Outcome['kind'] = row.index.lifecycle === 'outcome_uncertain' || row.index.lifecycle === 'superseded'
    || row.index.lifecycle === 'completed' ? 'unknown'
    : row.index.lifecycle === 'failed' || row.index.lifecycle === 'cancelled' ? 'failed' : 'not_completed';
  if (reference.actionId === 'deployments.templates.instantiate') {
    const template = DeploymentTemplateInstantiateResultV1Schema.safeParse(result);
    if (!template.success || template.data.kind === 'preview') return observation(lifecycleOutcome);
    const applied = template.data;
    if (applied.kind === 'partial' && applied.phase !== 'deploy') return observation(lifecycleOutcome);
    if (applied.environmentId === undefined || boundEnvironmentId !== undefined && applied.environmentId !== boundEnvironmentId
      || applied.deployment !== undefined && applied.deployment.environmentId !== applied.environmentId) return observation('unknown');
    environmentId = applied.environmentId;
    // A failed semantic parent can retain an accepted, still unresolved deploy.
    // Its Environment is useful for resume, but parent failure is not deploy failure.
    if (applied.kind === 'partial'
      && (applied.errorCode === 'outcome_unknown' || applied.errorCode === 'deployment_in_progress')) return observation('unknown');
    if (applied.kind === 'partial' && row.index.lifecycle === 'completed') return observation('unknown');
    result = applied.deployment;
  }
  if (row.index.lifecycle !== 'completed') return observation(lifecycleOutcome);
  const receipt = DeploymentReceiptResultV1Schema.safeParse(result);
  if (!receipt.success) return observation('unknown');
  if (!receipt.data.ok) return observation('failed');
  if (receipt.data.environmentId !== environmentId) return observation('unknown');
  const completed = prepareActionCompletionV1(getActionSpec('deployments.deploy').completion,
    { ok: true, result: receipt.data });
  return observation(completed.kind === 'completed' ? 'completed' : 'unknown');
}

/** Finite, caller-owned Account reads for the existing multi-app setup/resume review. */
export async function readMachineSetupAcceptedAppRuns(params: ReadRuntime & Readonly<{
  apps: readonly App[];
}>): Promise<readonly MachineSetupAcceptedAppRunObservation[]> {
  const readers = new Map<string, Promise<Awaited<ReturnType<typeof createReader>>>>();
  async function createReader(runId: string) {
    const run = await readAccepted(params, runId);
    if (!run) return undefined;
    const records = new Map<string, Promise<WorkflowInvocationDetailV1 | undefined>>();
    const pages = new Map<string, Promise<readonly WorkflowInvocationDetailV1[]>>();
    const readInvocation = (id: string): Promise<WorkflowInvocationDetailV1 | undefined> => {
      let pending = records.get(id);
      if (!pending) {
        pending = (async () => {
          if (!await params.isCurrent() || params.signal?.aborted) return undefined;
          const response = await params.execute('workflow.run.invocations.list', {
            runId, invocationId: id, includeContent: true,
          }, accountReadContext(params));
          if (!response.ok || !await params.isCurrent() || params.signal?.aborted) return undefined;
          const parsed = WorkflowInvocationListResultV1Schema.safeParse(response.result);
          const row = parsed.success && parsed.data.invocations.length === 1
            && parsed.data.invocationDetails?.length === 1 ? parsed.data.invocationDetails[0] : undefined;
          return row?.index.runId === runId && row.index.id === id ? row : undefined;
        })();
        records.set(id, pending);
      }
      return pending;
    };
    const list = (parentRecordId: string | null, memberOrdinal?: string): Promise<readonly WorkflowInvocationDetailV1[]> => {
      const key = JSON.stringify([parentRecordId, memberOrdinal]);
      let pending = pages.get(key);
      if (!pending) {
        pending = (async () => {
          const rows: WorkflowInvocationDetailV1[] = [];
          let cursor: string | undefined;
          do {
            if (!await params.isCurrent() || params.signal?.aborted) throw new Error('requester_unavailable');
            const response = await params.execute('workflow.run.invocations.list', {
              runId, parentRecordId, includeContent: true,
              ...(memberOrdinal === undefined ? {} : { memberOrdinal }), ...(cursor ? { cursor } : {}),
            }, accountReadContext(params));
            if (!response.ok || !await params.isCurrent() || params.signal?.aborted) throw new Error('run_unreadable');
            const page = WorkflowInvocationListResultV1Schema.parse(response.result);
            if (!page.invocationDetails || page.invocationDetails.length !== page.invocations.length) throw new Error('progress_unreadable');
            for (const row of page.invocationDetails) {
              if (row.index.runId !== runId || row.index.parentRecordId !== parentRecordId
                || memberOrdinal !== undefined && row.index.memberOrdinal !== memberOrdinal) throw new Error('member_mismatch');
              records.set(row.index.id, Promise.resolve(row));
              rows.push(row);
            }
            cursor = page.nextCursor;
          } while (cursor);
          return rows;
        })();
        pages.set(key, pending);
      }
      return pending;
    };
    const readCurrentRoot = async () => {
      const roots = await list(null, '0');
      return roots.length === 1 ? roots[0] : undefined;
    };
    let rootRead: Promise<WorkflowInvocationDetailV1 | undefined> | undefined;
    const readRoot = () => rootRead ??= (async () => {
      const original = run.checkpoint?.rootRecordId
        ? await readInvocation(run.checkpoint.rootRecordId) : await readCurrentRoot();
      return original ? await readWorkflowInvocationRootV1({ root: original,
        currentRootRecordId: run.checkpoint?.rootRecordId, readInvocation, readCurrentRoot }) : undefined;
    })();
    const readChildren = async (parentIds: string[], ordinal: string) =>
      (await Promise.all(parentIds.map(parentId => list(parentId, ordinal)))).flat();
    return { run, targets: nativeTargets(run, params.homeId, params.machineId), readRoot, readInvocation, readCurrentRoot, readChildren };
  }
  const observations = await Promise.all(params.apps.map(async app => {
    const unknown = (): MachineSetupAcceptedAppRunObservation => ({ ...app, outcome: { kind: 'unknown' } });
    const reference = app.reference;
    const identity = readMachineSetupAppIdentityV1({ kind: 'app', definition: app.intent,
      ...(app.authoredKey === undefined ? {} : { authoredKey: app.authoredKey }) });
    if (!reference || reference.homeId !== params.homeId || identity === undefined
      || readMachineSetupAppIdentityV1({ kind: 'app', definition: reference.intent,
        ...(reference.authoredKey === undefined ? {} : { authoredKey: reference.authoredKey }) }) !== identity) return unknown();
    try {
      if (!await params.isCurrent() || params.signal?.aborted) return unknown();
      const key = JSON.stringify([params.homeId, reference.runId]);
      let pending = readers.get(key);
      if (!pending) { pending = createReader(reference.runId); readers.set(key, pending); }
      const reader = await pending;
      const binding = reader && acceptedBinding(reader.run, reader.targets, params.homeId, app);
      if (!reader || !binding) return unknown();
      // This ordinal comes from the actual accepted definition, never source/item positions.
      const ordinals = reader.run.definition.blocks.flatMap((block, ordinal) =>
        block.kind === 'action' && block.id === reference.blockId && block.actionId === reference.actionId ? [ordinal] : []);
      if (ordinals.length !== 1 || reference.sourceKey !== '$root') return unknown();
      const root = await reader.readRoot();
      if (!root) return unknown();
      const ordinal = String(ordinals[0]!);
      const members = await readWorkflowInvocationMembersV1({ parentRecordIds: [root.index.id], memberOrdinal: ordinal,
        readParent: reader.readInvocation,
        readChildren: parents => reader.readChildren(parents, ordinal), indexOf: row => row.index });
      const selected = members.get(root.index.id);
      const row = selected?.length === 1 ? selected[0] : undefined;
      if (!row) return unknown();
      const ancestry = await readWorkflowCurrentInvocationAncestryV1({ invocation: row,
        currentRootRecordId: root.index.id, readInvocation: reader.readInvocation,
        readCurrentRoot: reader.readCurrentRoot, readChildren: reader.readChildren });
      const current = ancestry?.at(-1);
      if (!current || current.index.id !== row.index.id || current.progress.attempt !== current.index.attempt) return unknown();
      const structure = await resolveWorkflowInvocationStructureV1({ definition: reader.run.definition,
        frozenChildren: reader.run.acceptedContext.frozenChildren, invocation: current,
        inputs: reader.run.acceptedContext.inputs, readInvocation: reader.readInvocation, keyOfInvocation: item => item.index.id });
      if (!structure || structure.sourceKey !== reference.sourceKey || structure.leaf.kind !== 'action'
        || structure.leaf.id !== reference.blockId || structure.leaf.actionId !== reference.actionId) return unknown();
      const accepted = reader.run.acceptedContext.materializedLeaves.find(leaf => leaf.sourceKey === reference.sourceKey
        && leaf.blockId === reference.blockId && leaf.kind === 'action' && leaf.actionId === reference.actionId);
      if (!accepted || accepted.kind !== 'action') return unknown();
      const execution = current.progress.execution;
      if (execution && (execution.kind !== 'action' || execution.actionId !== reference.actionId
        || !sameStrictJsonValue(execution.input, accepted.actionInput)))
        return unknown();
      if (current.index.lifecycle === 'completed' && !execution) return unknown();
      if (!await params.isCurrent() || params.signal?.aborted) return unknown();
      return { ...app, ...settledOutcome(current, reference, binding.environmentId) };
    } catch {
      return unknown();
    }
  }));
  try {
    if (!params.signal?.aborted && await params.isCurrent()) return observations;
  } catch {
    // Custody/currentness loss applies to the whole returned batch.
  }
  return params.apps.map((app): MachineSetupAcceptedAppRunObservation => ({ ...app, outcome: { kind: 'unknown' } }));
}
