import {
    ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1,
    ActionOperationSnapshotPushV1Schema,
    isAccountScopedBlobCiphertextForKind,
    type ActionOperationSnapshotEphemeralV1,
} from '@happier-dev/protocol';

export function projectActionOperationSnapshotPush(
    raw: unknown,
    authenticatedMachineId: string | null,
): ActionOperationSnapshotEphemeralV1 | null {
    const parsed = ActionOperationSnapshotPushV1Schema.safeParse(raw);
    if (
        !parsed.success
        || !authenticatedMachineId
        || parsed.data.machineId !== authenticatedMachineId
        || !isAccountScopedBlobCiphertextForKind({
            kind: 'action_operation_snapshot',
            ciphertext: parsed.data.ciphertext,
        })
    ) {
        return null;
    }
    return {
        type: ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1,
        machineId: authenticatedMachineId,
        ciphertext: parsed.data.ciphertext,
    };
}
