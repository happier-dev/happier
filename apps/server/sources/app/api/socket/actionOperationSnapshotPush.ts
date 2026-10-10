import {
    ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
    ActionOperationRevisionEphemeralV1Schema,
    ActionOperationSnapshotPushV1Schema,
    isAccountScopedBlobCiphertextForKind,
    type ActionOperationRevisionEphemeralV1,
} from '@happier-dev/protocol';

export function projectActionOperationSnapshotPush(
    raw: unknown,
    authenticatedMachineId: string | null,
    account: Readonly<{ accountId: string; encryptionMode: 'plain' | 'e2ee' }>,
): ActionOperationRevisionEphemeralV1 | null {
    const current = ActionOperationSnapshotPushV1Schema.safeParse(raw);
    const released = current.success ? null : ActionOperationRevisionEphemeralV1Schema.safeParse(raw);
    const machineId = current.success ? current.data.machineId : released?.success ? released.data.machineId : null;
    const content = current.success ? { t: 'encrypted' as const, c: current.data.ciphertext }
        : released?.success ? released.data.content : null;
    if (
        !machineId
        || !content
        || !authenticatedMachineId
        || machineId !== authenticatedMachineId
    ) {
        return null;
    }
    if (content.t === 'plain') {
        if (account.encryptionMode !== 'plain' || content.v.scope.accountId !== account.accountId
            || content.v.scope.machineId !== authenticatedMachineId) return null;
    } else if (account.encryptionMode !== 'e2ee' || !isAccountScopedBlobCiphertextForKind({
        kind: 'action_operation_snapshot', ciphertext: content.c,
    })) return null;
    return {
        type: ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
        machineId: authenticatedMachineId,
        content,
    };
}
