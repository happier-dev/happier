import {
    ActionOperationRevisionEphemeralV1Schema,
    ActionOperationSnapshotEphemeralV1Schema,
    type ActionOperationSnapshotEphemeralV1,
} from '@happier-dev/protocol/actions/operations/v1';

/**
 * Normalizes the released 0.2.11 envelope and the drain-only pre-release 0.3
 * envelope before either can reach the single qualified operation store.
 */
export function normalizeActionOperationEphemeralIngress(
    raw: unknown,
): ActionOperationSnapshotEphemeralV1 | null {
    const released = ActionOperationRevisionEphemeralV1Schema.safeParse(raw);
    if (released.success) {
        return {
            type: 'action-operation-snapshot',
            machineId: released.data.machineId,
            ciphertext: released.data.content.c,
        };
    }

    const drainOnly = ActionOperationSnapshotEphemeralV1Schema.safeParse(raw);
    return drainOnly.success ? drainOnly.data : null;
}
