import { getSessionStateFieldDescriptor } from '@happier-dev/agents';
import { SessionStateFieldIdSchema, type SessionStateFieldId } from '@happier-dev/protocol';

import {
  createRegisteredSessionStateFieldMutation,
  type RegisteredSessionStateFieldMutationV1,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { splitDurableRegisteredSessionStateMetadata } from '@/agent/runtime/registry/pluginMetadataDurability';

type RegisteredSessionStateFieldEnqueuer = (
  mutation: RegisteredSessionStateFieldMutationV1,
) => void | Promise<void>;

export type ExecutionRunSessionStateTarget = Readonly<{
  sessionId: string;
  enqueueRegisteredSessionStateFieldMutation?: RegisteredSessionStateFieldEnqueuer;
}>;

export type ExecutionRunSessionStateDeliveryResultV1 =
  | Readonly<{
      status: 'queued';
      target: 'session' | 'execution_run';
      fieldId: SessionStateFieldId;
      mutationId: string;
    }>
  | Readonly<{
      status: 'delivered';
      target: 'session' | 'execution_run';
      fieldId: SessionStateFieldId;
    }>
  | Readonly<{
      status: 'unsupported';
      fieldId: SessionStateFieldId | null;
      reason: 'no_session_target' | 'unregistered_field' | 'scope_not_supported';
    }>;

export class ExecutionRunSessionStateUnsupportedError extends Error {
  readonly code = 'execution_run_session_state_unsupported';
  readonly result: Extract<ExecutionRunSessionStateDeliveryResultV1, { status: 'unsupported' }>;

  constructor(result: Extract<ExecutionRunSessionStateDeliveryResultV1, { status: 'unsupported' }>) {
    super(`Execution-run session state delivery unsupported: ${result.reason}`);
    this.name = 'ExecutionRunSessionStateUnsupportedError';
    this.result = result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFieldId(value: unknown): SessionStateFieldId | null {
  const parsed = SessionStateFieldIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readMetadataRegisteredFieldIds(candidate: unknown): readonly SessionStateFieldId[] {
  if (!isRecord(candidate)) return [];
  const fieldIds: SessionStateFieldId[] = [];
  if (hasOwn(candidate, 'sessionWorkStateV1')) {
    fieldIds.push('runtime.workState');
  }
  if (hasOwn(candidate, 'sessionUsageLimitRecoveryV1')) {
    fieldIds.push('runtime.usageLimitRecovery');
  }
  return fieldIds;
}

function resolveMetadataWriteCandidate(
  request: unknown,
): unknown | null {
  if (!isRecord(request) || typeof request.kind !== 'string') return null;
  if (request.kind === 'set') {
    return isRecord(request.metadata) ? request.metadata : {};
  }
  return null;
}

export function readExecutionRunSessionStateTarget(value: unknown): ExecutionRunSessionStateTarget | null {
  if (!isRecord(value)) return null;
  const rawTarget = value.parentSessionStateTarget;
  if (!isRecord(rawTarget)) return null;
  const sessionId = readTrimmedString(rawTarget.sessionId);
  if (!sessionId) return null;
  const enqueue = rawTarget.enqueueRegisteredSessionStateFieldMutation;
  return Object.freeze({
    sessionId,
    ...(typeof enqueue === 'function'
      ? {
        enqueueRegisteredSessionStateFieldMutation: (mutation: Parameters<RegisteredSessionStateFieldEnqueuer>[0]) =>
          (enqueue as RegisteredSessionStateFieldEnqueuer).call(rawTarget, mutation),
      }
      : {}),
  });
}

export function throwIfExecutionRunSessionStateUnsupported(
  result: ExecutionRunSessionStateDeliveryResultV1,
): void {
  if (result.status === 'unsupported') {
    throw new ExecutionRunSessionStateUnsupportedError(result);
  }
}

export async function deliverExecutionRunSessionStateField(
  params: Readonly<{
    target: ExecutionRunSessionStateTarget | null;
    fieldId: unknown;
    value: unknown;
  }>,
): Promise<ExecutionRunSessionStateDeliveryResultV1> {
  const fieldId = readFieldId(params.fieldId);
  if (!fieldId) {
    return {
      status: 'unsupported',
      fieldId: null,
      reason: 'unregistered_field',
    };
  }
  if (!params.target) {
    return {
      status: 'unsupported',
      fieldId,
      reason: 'no_session_target',
    };
  }
  if (fieldId === 'runtime.activity' || fieldId === 'runtime.externalAgent') {
    return {
      status: 'unsupported',
      fieldId,
      reason: 'scope_not_supported',
    };
  }

  const deliveryClass = getSessionStateFieldDescriptor(fieldId).deliveryClass;
  const enqueue = params.target.enqueueRegisteredSessionStateFieldMutation;
  if (deliveryClass === 'ephemeral_drop_ok' || typeof enqueue !== 'function') {
    return {
      status: 'unsupported',
      fieldId,
      reason: 'scope_not_supported',
    };
  }

  const mutation = createRegisteredSessionStateFieldMutation({
    sessionId: params.target.sessionId,
    fieldId,
    deliveryClass,
    source: 'runtime',
    op: params.value === null
      ? { kind: 'clear' }
      : { kind: 'set', value: params.value },
  });
  await enqueue(mutation);

  return {
    status: 'queued',
    target: 'session',
    fieldId,
    mutationId: mutation.mutationId,
  };
}

export async function deliverExecutionRunSessionMetadata(
  params: Readonly<{
    target: ExecutionRunSessionStateTarget | null;
    request: unknown;
  }>,
): Promise<ExecutionRunSessionStateDeliveryResultV1> {
  if (!params.target) {
    return {
      status: 'unsupported',
      fieldId: null,
      reason: 'no_session_target',
    };
  }
  if (isRecord(params.request) && params.request.kind === 'update') {
    return {
      status: 'unsupported',
      fieldId: null,
      reason: 'scope_not_supported',
    };
  }
  const candidate = resolveMetadataWriteCandidate(params.request);
  const registeredFieldIds = readMetadataRegisteredFieldIds(candidate);
  const firstFieldId = registeredFieldIds[0] ?? null;
  const enqueue = params.target.enqueueRegisteredSessionStateFieldMutation;
  if (typeof enqueue !== 'function' || registeredFieldIds.length === 0) {
    return {
      status: 'unsupported',
      fieldId: firstFieldId,
      reason: 'scope_not_supported',
    };
  }

  const split = splitDurableRegisteredSessionStateMetadata({
    sessionId: params.target.sessionId,
    current: {},
    candidate,
    source: 'runtime',
  });
  if (split.mutations.length === 0) {
    return {
      status: 'unsupported',
      fieldId: firstFieldId,
      reason: 'scope_not_supported',
    };
  }

  for (const mutation of split.mutations) {
    await enqueue(mutation);
  }
  const firstMutation = split.mutations[0];
  return {
    status: 'queued',
    target: 'session',
    fieldId: firstMutation.fieldId,
    mutationId: firstMutation.mutationId,
  };
}
