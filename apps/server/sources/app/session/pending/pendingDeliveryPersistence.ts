import { pendingDeliveryStatusV1ToPersistedFields, type PendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { getActivePrismaRuntime } from '@/storage/prisma';

/** Protocol owns status transitions; ended Pending also releases its private birth custody. */
export function pendingDeliveryStatusToPersistence(status: PendingDeliveryStatusV1) {
    const fields = pendingDeliveryStatusV1ToPersistedFields(status);
    return {
        ...fields,
        ...(fields.status === 'discarded' ? { requesterBootstrap: getActivePrismaRuntime().DbNull } : {}),
    };
}
