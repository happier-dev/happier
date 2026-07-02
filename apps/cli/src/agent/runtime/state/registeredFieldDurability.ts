import {
  createRegisteredSessionStateFieldMutation,
  type RegisteredSessionStateFieldMutationV1,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type {
  SessionStateFieldWriteValue,
  SessionStateMetadataWriteResult,
} from '@happier-dev/agents';
import { getSessionStateFieldDescriptor } from '@happier-dev/agents';
import type { SessionStateFieldId } from '@happier-dev/protocol';

type RegisteredSessionStateFieldEnqueuer = (
  mutation: RegisteredSessionStateFieldMutationV1,
) => void | Promise<void>;

export function resolveRegisteredSessionStateFieldDeliveryClass(
  fieldId: SessionStateFieldId,
): RegisteredSessionStateFieldMutationV1['deliveryClass'] | null {
  const deliveryClass = getSessionStateFieldDescriptor(fieldId).deliveryClass;
  return deliveryClass === 'durable_required' ? deliveryClass : null;
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
  if (!deliveryClass || !params.enqueue) return null;
  await params.enqueue(createRegisteredSessionStateFieldMutation({
    sessionId: params.sessionId,
    fieldId: params.fieldId,
    deliveryClass,
    source: params.source,
    op: params.value === null
      ? { kind: 'clear' }
      : { kind: 'set', value: params.value },
  }));
  return { ok: true, version: 0 };
}
