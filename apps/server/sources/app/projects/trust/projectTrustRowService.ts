import {
    assertProjectTrustContentForModeV1, assertProjectTrustValueForProjectV1, ProjectTrustChangeHintV1Schema, ProjectTrustContentV1Schema,
    StoredProjectTrustContentV1Schema, type ProjectTrustContentV1, type ProjectTrustRowV1, type QualifiedProjectTrustProjectV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { PROJECT_TRUST_ACCOUNT_KV_PREFIX, buildProjectTrustPhysicalKey, parseProjectTrustPhysicalKey } from '@/app/kv/accountScopedKv';
import {
    listReservedAccountScopedKvRowsInTx, mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain, type ReservedAccountScopedKvRowFailure,
    type ReservedAccountScopedKvRowReadResult, type ReservedAccountScopedKvRowMutationResult,
} from '@/app/kv/reservedAccountScopedKvRow';
import { inTx, type Tx } from '@/storage/inTx';

export function isProjectTrustContentBoundToProject(content: ProjectTrustContentV1 | null, project: QualifiedProjectTrustProjectV1): boolean {
    if (content === null || content.t === 'encrypted') return true;
    try { assertProjectTrustValueForProjectV1(content.v, project); return true; } catch { return false; }
}

/** Grammar and mode only; the server cannot inspect opaque E2EE project binding. */
export const projectTrustDomain: ReservedAccountScopedKvRowDomain<ProjectTrustContentV1> = Object.freeze({
    label: 'Project Trust',
    parseStoredEnvelope: value => { const parsed = StoredProjectTrustContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    parseCandidateEnvelope: value => { const parsed = ProjectTrustContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    assertEnvelopeForMode: (envelope, mode) => { assertProjectTrustContentForModeV1(envelope, mode); },
});

function domainForProject(project: QualifiedProjectTrustProjectV1): ReservedAccountScopedKvRowDomain<ProjectTrustContentV1> {
    const bound = (content: ProjectTrustContentV1 | null) => content && isProjectTrustContentBoundToProject(content, project) ? content : null;
    return { ...projectTrustDomain,
        parseStoredEnvelope: value => bound(projectTrustDomain.parseStoredEnvelope(value)),
        parseCandidateEnvelope: value => bound(projectTrustDomain.parseCandidateEnvelope(value)),
    };
}

export async function markProjectTrustChangedInTx(tx: Tx, input: Readonly<{ accountId: string; project: QualifiedProjectTrustProjectV1; revision: number }>): Promise<number> {
    return await markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: buildProjectTrustPhysicalKey(input.project),
        hint: ProjectTrustChangeHintV1Schema.parse({ projectTrust: true, project: input.project, revision: input.revision }),
    });
}

export async function readProjectTrustInTx(tx: Tx, input: Readonly<{ accountId: string; project: QualifiedProjectTrustProjectV1 }>): Promise<ReservedAccountScopedKvRowReadResult<ProjectTrustContentV1>> {
    return await readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: buildProjectTrustPhysicalKey(input.project), domain: domainForProject(input.project) });
}

export async function listProjectTrustInTx(tx: Tx, input: Readonly<{ accountId: string; project?: QualifiedProjectTrustProjectV1 }>): Promise<Readonly<{ status: 'listed'; rows: readonly ProjectTrustRowV1[] }> | ReservedAccountScopedKvRowFailure> {
    if (input.project) {
        const row = await readProjectTrustInTx(tx, { accountId: input.accountId, project: input.project });
        if (row.status === 'absent') return { status: 'listed', rows: [] };
        if (row.status === 'present' || row.status === 'deleted') return { status: 'listed', rows: [{ project: input.project, revision: row.revision, content: row.status === 'present' ? row.envelope : null }] };
        return row;
    }
    const result = await listReservedAccountScopedKvRowsInTx(tx, { accountId: input.accountId, physicalPrefix: PROJECT_TRUST_ACCOUNT_KV_PREFIX, domain: projectTrustDomain });
    if (result.status !== 'listed') return result;
    const rows: ProjectTrustRowV1[] = [];
    for (const row of result.rows) {
        const project = parseProjectTrustPhysicalKey(row.physicalKey);
        if (!project || !isProjectTrustContentBoundToProject(row.envelope, project)) return { status: 'invalid-stored-content' };
        rows.push({ project, revision: row.revision, content: row.envelope });
    }
    return { status: 'listed', rows };
}

export async function mutateProjectTrustInTx(tx: Tx, input: Readonly<{ accountId: string; project: QualifiedProjectTrustProjectV1; expectedRevision: number | 'absent'; content: ProjectTrustContentV1 | null }>): Promise<ReservedAccountScopedKvRowMutationResult> {
    return await mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: buildProjectTrustPhysicalKey(input.project),
        expectedRevision: input.expectedRevision, envelope: input.content, domain: domainForProject(input.project),
        markChanged: ({ tx: changeTx, revision }) => markProjectTrustChangedInTx(changeTx, { accountId: input.accountId, project: input.project, revision }),
    });
}

export async function readProjectTrust(input: Parameters<typeof readProjectTrustInTx>[1]): ReturnType<typeof readProjectTrustInTx> { return await inTx(tx => readProjectTrustInTx(tx, input)); }
export async function listProjectTrust(input: Parameters<typeof listProjectTrustInTx>[1]): ReturnType<typeof listProjectTrustInTx> { return await inTx(tx => listProjectTrustInTx(tx, input)); }
export async function mutateProjectTrust(input: Parameters<typeof mutateProjectTrustInTx>[1]): ReturnType<typeof mutateProjectTrustInTx> { return await inTx(tx => mutateProjectTrustInTx(tx, input)); }
