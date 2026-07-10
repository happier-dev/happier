import {
  readSessionMetadataRuntimeDescriptor,
  type HostRuntimeControlServiceV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  readDisplayableSessionWorkStateV1,
  type SessionWorkStateItemV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import {
  isCodexAppServerInvalidParamsError,
  isCodexAppServerInvalidRequestForMethodError,
  isCodexAppServerMethodNotFoundError,
} from '../compatibility.js';
import {
  mergeCodexGoalIntoSessionWorkStateMetadata,
  removeCodexGoalFromSessionWorkStateMetadata,
} from '../work/state.js';
import { resolvePersistedCodexProviderSessionId } from '../../../identity/runtimeDescriptor.js';
import {
  goalNotFound,
  goalObjectiveRequired,
  goalThreadIdMissing,
  invalidGoalStatus,
  unsupportedGoalClear,
  unsupportedGoalGet,
  unsupportedGoalSet,
  type CodexAppServerGoalControlResult,
  type CodexAppServerGoalSetMutation,
} from '../work/goalControl.js';

type MetadataRecord = Record<string, unknown>;

type GoalControlInput<TParams> = Readonly<{
  runtimeControl: HostRuntimeControlServiceV1;
  params: TParams;
}>;

type GoalControlParams = Readonly<{
  metadata: MetadataRecord;
  request?: Readonly<{
    objective?: string;
    status?: string;
    tokenBudget?: number | null;
  }>;
}>;

function readThreadId(metadata: unknown): string | null {
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  const fromDescriptor = runtimeDescriptor?.providerSessionId?.trim();
  if (fromDescriptor) return fromDescriptor;
  return resolvePersistedCodexProviderSessionId(metadata);
}

function isOlderCodexObjectiveRequiredError(error: unknown): boolean {
  return isCodexAppServerInvalidParamsError(error)
    || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/set');
}

function readGoalFromResponse(response: unknown): unknown | null {
  if (!response || typeof response !== 'object') return null;
  if (
    typeof (response as { threadId?: unknown }).threadId === 'string'
    && typeof (response as { objective?: unknown }).objective === 'string'
    && typeof (response as { status?: unknown }).status === 'string'
  ) {
    return response;
  }
  const goal = (response as { goal?: unknown }).goal;
  return goal && typeof goal === 'object' ? goal : null;
}

function readGoalObjective(goal: unknown): string | null {
  if (!goal || typeof goal !== 'object') return null;
  const objective = (goal as { objective?: unknown }).objective;
  if (typeof objective !== 'string') return null;
  const trimmed = objective.trim();
  return trimmed ? trimmed : null;
}

function readCurrentGoalItem(metadata: unknown, threadId: string): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const workState = (metadata as { sessionWorkStateV1?: unknown }).sessionWorkStateV1;
  if (!workState || typeof workState !== 'object') return null;
  const items = (workState as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  return items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .find((item) => item.kind === 'goal' && (
      item.vendorRef === threadId
      || item.id === `goal:${threadId}`
      || item.id === 'goal:codex:thread'
    )) ?? null;
}

function shouldReactivateForObjectiveEdit(params: Readonly<{
  metadata: unknown;
  threadId: string;
  mutation: CodexAppServerGoalSetMutation;
}>): boolean {
  if (typeof params.mutation.objective !== 'string' || params.mutation.objective.trim().length === 0) return false;
  if (typeof params.mutation.status === 'string') return false;

  const goalItem = readCurrentGoalItem(params.metadata, params.threadId);
  if (!goalItem) return false;
  if (goalItem.status === 'complete') return true;
  return goalItem.status === 'blocked' && goalItem.statusReason === 'budgetLimited';
}

function normalizeNativeStatus(status: SessionWorkStateItemV1['status'] | undefined): 'active' | 'paused' | 'complete' | undefined | null {
  if (status === undefined) return undefined;
  if (status === 'active' || status === 'paused' || status === 'complete') return status;
  return null;
}

function hasMutationField(mutation: CodexAppServerGoalSetMutation): boolean {
  return typeof mutation.objective === 'string'
    || typeof mutation.status === 'string'
    || Object.prototype.hasOwnProperty.call(mutation, 'tokenBudget');
}

function buildGoalSetParams(params: Readonly<{
  threadId: string;
  metadata: MetadataRecord;
  mutation: CodexAppServerGoalSetMutation;
  fallbackObjective?: string;
}>): Record<string, unknown> | null {
  if (!hasMutationField(params.mutation)) return null;

  const status = normalizeNativeStatus(params.mutation.status);
  if (status === null) return null;

  const objective = typeof params.mutation.objective === 'string'
    ? params.mutation.objective.trim()
    : params.fallbackObjective;
  if (typeof params.mutation.objective === 'string' && !objective) return null;

  return {
    threadId: params.threadId,
    ...(objective ? { objective } : {}),
    ...(status ? { status } : {}),
    ...(shouldReactivateForObjectiveEdit({
      metadata: params.metadata,
      threadId: params.threadId,
      mutation: params.mutation,
    }) ? { status: 'active' } : {}),
    ...(Object.prototype.hasOwnProperty.call(params.mutation, 'tokenBudget')
      ? { tokenBudget: params.mutation.tokenBudget ?? null }
      : {}),
  };
}

function successWithMetadata(metadata: MetadataRecord): CodexAppServerGoalControlResult {
  return {
    metadata,
    workState: readDisplayableSessionWorkStateV1(metadata.sessionWorkStateV1),
  };
}

async function request(
  runtimeControl: HostRuntimeControlServiceV1,
  method: string,
  params: unknown,
): Promise<unknown> {
  const result = await runtimeControl.appServer.request({ method, params });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function getNativeGoal(runtimeControl: HostRuntimeControlServiceV1, threadId: string): Promise<unknown | null> {
  const response = await request(runtimeControl, 'thread/goal/get', { threadId });
  return readGoalFromResponse(response);
}

export async function getCodexGoal(
  input: GoalControlInput<GoalControlParams>,
): Promise<CodexAppServerGoalControlResult> {
  const metadata = input.params.metadata ? { ...input.params.metadata } : {};
  const threadId = readThreadId(metadata);
  if (!threadId) return goalThreadIdMissing();

  try {
    const goal = await getNativeGoal(input.runtimeControl, threadId);
    const nextMetadata = goal
      ? mergeCodexGoalIntoSessionWorkStateMetadata(metadata, goal)
      : removeCodexGoalFromSessionWorkStateMetadata(metadata);
    return successWithMetadata(nextMetadata);
  } catch (error) {
    if (isCodexAppServerMethodNotFoundError(error)
      || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/get')) {
      return unsupportedGoalGet();
    }
    return unsupportedGoalGet();
  }
}

export async function setCodexGoal(
  input: GoalControlInput<GoalControlParams>,
): Promise<CodexAppServerGoalControlResult> {
  const metadata = input.params.metadata ? { ...input.params.metadata } : {};
  const threadId = readThreadId(metadata);
  if (!threadId) return goalThreadIdMissing();
  const requestInput = input.params.request ?? {};
  const mutation: CodexAppServerGoalSetMutation = {
    ...(typeof requestInput.objective === 'string' ? { objective: requestInput.objective } : {}),
    ...(typeof requestInput.status === 'string' ? { status: requestInput.status as CodexAppServerGoalSetMutation['status'] } : {}),
    ...(Object.prototype.hasOwnProperty.call(requestInput, 'tokenBudget')
      ? { tokenBudget: requestInput.tokenBudget ?? null }
      : {}),
  };
  const requestParams = buildGoalSetParams({ threadId, metadata, mutation });
  if (!requestParams) {
    return typeof mutation.status === 'string' && normalizeNativeStatus(mutation.status) === null
      ? invalidGoalStatus()
      : goalObjectiveRequired();
  }

  try {
    const response = await request(input.runtimeControl, 'thread/goal/set', requestParams);
    const goal = readGoalFromResponse(response);
    const nextMetadata = goal
      ? mergeCodexGoalIntoSessionWorkStateMetadata(metadata, goal)
      : removeCodexGoalFromSessionWorkStateMetadata(metadata);
    return successWithMetadata(nextMetadata);
  } catch (error) {
    if (isCodexAppServerMethodNotFoundError(error)) return unsupportedGoalSet();
    if (!isOlderCodexObjectiveRequiredError(error)) return unsupportedGoalSet();

    let goal: unknown | null;
    try {
      goal = await getNativeGoal(input.runtimeControl, threadId);
    } catch {
      return unsupportedGoalSet();
    }
    const objective = readGoalObjective(goal);
    if (!objective) return goalNotFound();

    const retryParams = buildGoalSetParams({
      threadId,
      metadata,
      mutation,
      fallbackObjective: objective,
    });
    if (!retryParams) return goalObjectiveRequired();
    const retryResponse = await request(input.runtimeControl, 'thread/goal/set', retryParams);
    const nextGoal = readGoalFromResponse(retryResponse);
    const nextMetadata = nextGoal
      ? mergeCodexGoalIntoSessionWorkStateMetadata(metadata, nextGoal)
      : removeCodexGoalFromSessionWorkStateMetadata(metadata);
    return successWithMetadata(nextMetadata);
  }
}

export async function clearCodexGoal(
  input: GoalControlInput<GoalControlParams>,
): Promise<CodexAppServerGoalControlResult> {
  const metadata = input.params.metadata ? { ...input.params.metadata } : {};
  const threadId = readThreadId(metadata);
  if (!threadId) return goalThreadIdMissing();

  try {
    await request(input.runtimeControl, 'thread/goal/clear', { threadId });
    return successWithMetadata(removeCodexGoalFromSessionWorkStateMetadata(metadata));
  } catch (error) {
    if (isCodexAppServerMethodNotFoundError(error)
      || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/clear')) {
      return unsupportedGoalClear();
    }
    return unsupportedGoalClear();
  }
}
