import {
    assertWorkspaceExecutionConfigContentForModeV1,
    buildWorkspaceExecutionConfigPhysicalKeyV1,
    buildWorkspaceExecutionConfigRowIdV1,
    parseWorkspaceExecutionConfigPhysicalKeyV1,
    StoredWorkspaceExecutionConfigContentV1Schema,
    WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1,
    WorkspaceExecutionConfigChangeHintV1Schema,
    WorkspaceExecutionConfigContentV1Schema,
    type WorkspaceExecutionConfigContentV1,
    type WorkspaceExecutionConfigRowV1,
} from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { WorkspaceExecutionConfigAddressV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import {
    listReservedAccountScopedKvRowsInTx,
    mutateReservedAccountScopedKvRowInTx,
    readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
    type ReservedAccountScopedKvRowFailure,
    type ReservedAccountScopedKvRowReadResult,
    type ReservedAccountScopedKvRowMutationResult,
} from '@/app/kv/reservedAccountScopedKvRow';
import { inTx, type Tx } from '@/storage/inTx';

export const workspaceExecutionConfigRowDomain: ReservedAccountScopedKvRowDomain<WorkspaceExecutionConfigContentV1> = Object.freeze({
    label: 'Workspace execution config',
    parseStoredEnvelope(value: unknown) {
        const parsed = StoredWorkspaceExecutionConfigContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseCandidateEnvelope(value: unknown) {
        const parsed = WorkspaceExecutionConfigContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    assertEnvelopeForMode: assertWorkspaceExecutionConfigContentForModeV1,
});

export async function markWorkspaceExecutionConfigChangedInTx(tx: Tx, input: Readonly<{ accountId: string; rowId: string; revision: number }>): Promise<number> {
    return await markAccountChanged(tx, {
        accountId: input.accountId, kind: 'account', entityId: buildWorkspaceExecutionConfigPhysicalKeyV1(input.rowId),
        hint: WorkspaceExecutionConfigChangeHintV1Schema.parse({ workspaceExecutionConfig: true, rowId: input.rowId, revision: input.revision }),
    });
}

/** The shared primitive owns Account mode, envelope admission and tombstone revisions. */
export async function readWorkspaceExecutionConfigRowInTx(tx: Tx, input: Readonly<{ accountId: string; address: WorkspaceExecutionConfigAddressV1 }>): Promise<ReservedAccountScopedKvRowReadResult<WorkspaceExecutionConfigContentV1>> {
    return await readReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId, physicalKey: buildWorkspaceExecutionConfigPhysicalKeyV1(buildWorkspaceExecutionConfigRowIdV1(input.address)),
        domain: workspaceExecutionConfigRowDomain,
    });
}
export async function listWorkspaceExecutionConfigRowsInTx(tx: Tx, input: Readonly<{ accountId: string }>): Promise<
    Readonly<{ status: 'listed'; rows: readonly WorkspaceExecutionConfigRowV1[] }> | ReservedAccountScopedKvRowFailure
> {
    const result = await listReservedAccountScopedKvRowsInTx(tx, {
        accountId: input.accountId, physicalPrefix: WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1, domain: workspaceExecutionConfigRowDomain,
    });
    if (result.status !== 'listed') return result;
    const rows: WorkspaceExecutionConfigRowV1[] = [];
    for (const row of result.rows) {
        const rowId = parseWorkspaceExecutionConfigPhysicalKeyV1(row.physicalKey);
        if (rowId === null) return { status: 'invalid-stored-content' };
        rows.push({ rowId, revision: row.revision, content: row.envelope });
    }
    return { status: 'listed', rows };
}
export async function mutateWorkspaceExecutionConfigRowInTx(tx: Tx, input: Readonly<{
    accountId: string; address: WorkspaceExecutionConfigAddressV1;
    expectedRevision: number | 'absent'; content: WorkspaceExecutionConfigContentV1 | null;
}>): Promise<ReservedAccountScopedKvRowMutationResult> {
    const rowId = buildWorkspaceExecutionConfigRowIdV1(input.address);
    return await mutateReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId, physicalKey: buildWorkspaceExecutionConfigPhysicalKeyV1(rowId),
        expectedRevision: input.expectedRevision, envelope: input.content, domain: workspaceExecutionConfigRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markWorkspaceExecutionConfigChangedInTx(changeTx, { accountId: input.accountId, rowId, revision }),
    });
}
export function readWorkspaceExecutionConfigRow(input: Parameters<typeof readWorkspaceExecutionConfigRowInTx>[1]): Promise<ReservedAccountScopedKvRowReadResult<WorkspaceExecutionConfigContentV1>> {
    return inTx(tx => readWorkspaceExecutionConfigRowInTx(tx, input), { readOnly: true });
}
export function mutateWorkspaceExecutionConfigRow(input: Parameters<typeof mutateWorkspaceExecutionConfigRowInTx>[1]): Promise<ReservedAccountScopedKvRowMutationResult> {
    return inTx(tx => mutateWorkspaceExecutionConfigRowInTx(tx, input));
}
