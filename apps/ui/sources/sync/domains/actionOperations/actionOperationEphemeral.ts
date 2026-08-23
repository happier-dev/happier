import {
    ActionOperationSnapshotV1Schema,
    openAccountScopedBlobCiphertext,
    type ActionOperationRevisionEphemeralV1,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

export function openActionOperationRevisionEphemeral(params: Readonly<{
    update: ActionOperationRevisionEphemeralV1;
    machineKey: Uint8Array;
}>): ActionOperationSnapshotV1 | null {
    const opened = openAccountScopedBlobCiphertext({
        kind: 'action_operation_snapshot',
        material: { type: 'dataKey', machineKey: params.machineKey },
        ciphertext: params.update.content.c,
    });
    if (!opened) return null;
    const parsed = ActionOperationSnapshotV1Schema.safeParse(opened.value);
    if (!parsed.success || parsed.data.scope.machineId !== params.update.machineId) return null;
    return parsed.data;
}
