import {
    ActionOperationSnapshotV1Schema,
    openAccountScopedBlobCiphertext,
    type ActionOperationRevisionEphemeralV1,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

export function openActionOperationRevisionEphemeral(params: Readonly<{
    update: ActionOperationRevisionEphemeralV1;
    machineKey: Uint8Array | null;
    machineMode: 'plain' | 'e2ee';
    accountId: string;
}>): ActionOperationSnapshotV1 | null {
    if (params.update.content.t === 'plain' && params.machineMode !== 'plain') return null;
    if (params.update.content.t === 'encrypted' && (params.machineMode !== 'e2ee' || !params.machineKey)) return null;
    let value: unknown;
    if (params.update.content.t === 'plain') {
        value = params.update.content.v;
    } else {
        if (!params.machineKey) return null;
        const opened = openAccountScopedBlobCiphertext({
            kind: 'action_operation_snapshot',
            material: { type: 'dataKey', machineKey: params.machineKey },
            ciphertext: params.update.content.c,
        });
        if (!opened) return null;
        value = opened.value;
    }
    const parsed = ActionOperationSnapshotV1Schema.safeParse(value);
    if (!parsed.success || parsed.data.scope.machineId !== params.update.machineId
        || parsed.data.scope.accountId !== params.accountId) return null;
    return parsed.data;
}
