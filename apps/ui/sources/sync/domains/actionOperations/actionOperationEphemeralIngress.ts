import {
    ActionOperationRevisionEphemeralV1Schema,
    ActionOperationSnapshotEphemeralV1Schema,
    type ActionOperationRevisionEphemeralV1,
} from '@happier-dev/protocol/actions/operations/v1';

/**
 * Normalizes the released 0.2.11 envelope and the drain-only pre-release 0.3
 * envelope before either can reach the single qualified operation store.
 */
export function normalizeActionOperationEphemeralIngress(
    raw: unknown,
): ActionOperationRevisionEphemeralV1 | null {
    const released = ActionOperationRevisionEphemeralV1Schema.safeParse(raw);
    if (released.success) {
        return released.data;
    }

    const drainOnly = ActionOperationSnapshotEphemeralV1Schema.safeParse(raw);
    return drainOnly.success ? { type: 'action-operation-updated', machineId: drainOnly.data.machineId,
        content: { t: 'encrypted', c: drainOnly.data.ciphertext } } : null;
}
