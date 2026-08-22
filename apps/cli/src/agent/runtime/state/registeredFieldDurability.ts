import {
  createRegisteredSessionStateFieldMutation,
  type RegisteredSessionStateFieldMutationV1,
} from '../../../api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type {
  SessionStateFieldWriteValue,
  SessionStateMetadataWriteResult,
} from '@happier-dev/agents';
import { getSessionStateFieldDescriptor } from '@happier-dev/agents';
import type { SessionStateFieldId } from '@happier-dev/protocol';

type RegisteredSessionStateFieldEnqueuer = (
  mutation: RegisteredSessionStateFieldMutationV1,
) => void | Promise<void>;

type RegisteredSessionStateFieldExactDeliveryEnqueuer = (
  mutation: RegisteredSessionStateFieldMutationV1,
) => Promise<Readonly<{ status: 'applied' | 'superseded' | 'failed' }>>;

function createDurableRegisteredSessionStateFieldWriteMutation<F extends SessionStateFieldId>(params: Readonly<{
  sessionId: string;
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
  source: RegisteredSessionStateFieldMutationV1['source'];
  deliveryClass: RegisteredSessionStateFieldMutationV1['deliveryClass'];
}>): RegisteredSessionStateFieldMutationV1 {
  return createRegisteredSessionStateFieldMutation({
    sessionId: params.sessionId,
    fieldId: params.fieldId,
    deliveryClass: params.deliveryClass,
    source: params.source,
    op: params.value === null
      ? { kind: 'clear' }
      : { kind: 'set', value: params.value },
  });
}

type DurableRegisteredSessionStateFieldDeliveryFailure = Extract<
  SessionStateMetadataWriteResult,
  { ok: false; reason: 'durable_delivery_unavailable' }
>;

export class DurableRegisteredSessionStateFieldDeliveryUnavailableError extends Error {
  readonly code = 'durable_registered_session_state_field_delivery_unavailable';
  readonly result: DurableRegisteredSessionStateFieldDeliveryFailure;

  constructor(result: DurableRegisteredSessionStateFieldDeliveryFailure) {
    super(`Durable registered session-state field delivery unavailable for ${result.fieldId}`);
    this.name = 'DurableRegisteredSessionStateFieldDeliveryUnavailableError';
    this.result = result;
  }
}

export function throwIfDurableRegisteredSessionStateFieldDeliveryUnavailable(
  result: SessionStateMetadataWriteResult,
): void {
  if (!result.ok && result.reason === 'durable_delivery_unavailable') {
    throw new DurableRegisteredSessionStateFieldDeliveryUnavailableError(result);
  }
}

export function resolveRegisteredSessionStateFieldDeliveryClass(
  fieldId: SessionStateFieldId,
): RegisteredSessionStateFieldMutationV1['deliveryClass'] | null {
  const deliveryClass = getSessionStateFieldDescriptor(fieldId).deliveryClass;
  return deliveryClass === 'ephemeral_drop_ok' ? null : deliveryClass;
}

export async function enqueueDurableRegisteredSessionStateFieldWrite<F extends SessionStateFieldId>(
  params: Readonly<{
    sessionId: string;
    fieldId: F;
    value: SessionStateFieldWriteValue<F>;
    source: RegisteredSessionStateFieldMutationV1['source'];
    enqueue?: RegisteredSessionStateFieldEnqueuer;
  }>,
): Promise<SessionStateMetadataWriteResult | null> {
  const deliveryClass = resolveRegisteredSessionStateFieldDeliveryClass(params.fieldId);
  if (!deliveryClass) return null;
  if (!params.enqueue) {
    if (deliveryClass === 'durable_best_effort') return null;
    return {
      ok: false,
      reason: 'durable_delivery_unavailable',
      fieldId: params.fieldId,
      deliveryClass: 'durable_required',
    };
  }
  try {
    await params.enqueue(createDurableRegisteredSessionStateFieldWriteMutation({ ...params, deliveryClass }));
  } catch (error) {
    if (error instanceof DurableRegisteredSessionStateFieldDeliveryUnavailableError) {
      return error.result;
    }
    throw error;
  }
  return { ok: true, version: 0 };
}

export async function enqueueDurableRegisteredSessionStateFieldWriteAndWaitForDelivery<
  F extends SessionStateFieldId,
>(params: Readonly<{
  sessionId: string;
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
  source: RegisteredSessionStateFieldMutationV1['source'];
  enqueueAndWaitForDelivery?: RegisteredSessionStateFieldExactDeliveryEnqueuer;
}>): Promise<Readonly<{ status: 'applied' | 'superseded' | 'failed' }>> {
  const deliveryClass = resolveRegisteredSessionStateFieldDeliveryClass(params.fieldId);
  if (!deliveryClass || !params.enqueueAndWaitForDelivery) return { status: 'failed' };
  return await params.enqueueAndWaitForDelivery(
    createDurableRegisteredSessionStateFieldWriteMutation({ ...params, deliveryClass }),
  );
}
