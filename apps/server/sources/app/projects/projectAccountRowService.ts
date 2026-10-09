import {
    PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1,
    ProjectAccountRowChangeHintV1Schema,
    ProjectAccountRowContentV1Schema,
    ProjectAccountRowMutationRequestV1Schema,
    StoredProjectAccountRowContentV1Schema,
    assertProjectAccountRowContentForModeV1,
    assertProjectAccountRowPayloadBindingV1,
    buildProjectAccountRowPhysicalKeyV1,
    parseProjectAccountRowPhysicalKeyV1,
    type ProjectAccountRowContentV1,
    type ProjectAccountRowFailureV1,
    type ProjectAccountRowKeyV1,
    type ProjectAccountRowListRequestV1,
    type ProjectAccountRowListResponseV1,
    type ProjectAccountRowMutationRequestV1,
    type ProjectAccountRowMutationResponseV1,
    type ProjectAccountRowReadResponseV1,
    type ProjectAccountRowV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import {
    listReservedAccountScopedKvRowsInTx,
    mutateReservedAccountScopedKvRowInTx,
    readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
} from '@/app/kv/reservedAccountScopedKvRow';
import { inTx, type Tx } from '@/storage/inTx';

function domainForKey(key?: ProjectAccountRowKeyV1): ReservedAccountScopedKvRowDomain<ProjectAccountRowContentV1> {
    const parse = (input: unknown, stored: boolean): ProjectAccountRowContentV1 | null => {
        const parsed = (stored ? StoredProjectAccountRowContentV1Schema : ProjectAccountRowContentV1Schema).safeParse(input);
        if (!parsed.success) return null;
        if (key && parsed.data.t === 'plain') {
            try { assertProjectAccountRowPayloadBindingV1(key, parsed.data.v); }
            catch { return null; }
        }
        return parsed.data;
    };
    return {
        label: 'Project Account row',
        parseStoredEnvelope: value => parse(value, true),
        parseCandidateEnvelope: value => parse(value, false),
        assertEnvelopeForMode: (content, mode) => { assertProjectAccountRowContentForModeV1(content, mode); },
    };
}

/** Publishes only the changed row identity/revision through the incumbent change stream. */
export async function markProjectAccountRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; key: ProjectAccountRowKeyV1; revision: number }>): Promise<number> {
    return await markAccountChanged(tx, {
        accountId: input.accountId, kind: 'account', entityId: buildProjectAccountRowPhysicalKeyV1(input.key),
        hint: ProjectAccountRowChangeHintV1Schema.parse({ projectAccountRow: true, key: input.key, revision: input.revision }),
    });
}

export async function readProjectAccountRowInTx(tx: Tx, input: Readonly<{ accountId: string; key: ProjectAccountRowKeyV1 }>): Promise<ProjectAccountRowReadResponseV1> {
    const result = await readReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId, physicalKey: buildProjectAccountRowPhysicalKeyV1(input.key), domain: domainForKey(input.key),
    });
    if (result.status !== 'present') return result;
    return { status: 'present', row: { key: input.key, revision: result.revision, content: result.envelope } };
}

/** A complete private census; invalid retained content refuses rather than disappearing. */
export async function listProjectAccountRowsInTx(tx: Tx, input: Readonly<{ accountId: string }> & ProjectAccountRowListRequestV1): Promise<ProjectAccountRowListResponseV1> {
    const result = await listReservedAccountScopedKvRowsInTx(tx, {
        accountId: input.accountId, physicalPrefix: PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1, domain: domainForKey(),
    });
    if (result.status !== 'listed') return result;
    const rows: ProjectAccountRowV1[] = [];
    for (const row of result.rows) {
        const key = parseProjectAccountRowPhysicalKeyV1(row.physicalKey);
        if (!key) return { status: 'invalid-stored-content' };
        if (row.envelope?.t === 'plain') {
            try { assertProjectAccountRowPayloadBindingV1(key, row.envelope.v); }
            catch { return { status: 'invalid-stored-content' }; }
        }
        if (input.kinds && !input.kinds.includes(key.kind)) continue;
        if (input.serverId && key.kind !== 'relationship-graph' && key.serverId !== input.serverId) continue;
        rows.push({ key, revision: row.revision, content: row.envelope });
    }
    return { status: 'listed', rows, coverage: 'complete' };
}

class ProjectAccountRowTransactionAbort extends Error {
    constructor(readonly result: ProjectAccountRowFailureV1) { super(result.status); }
}
function abort(result: ProjectAccountRowFailureV1): never { throw new ProjectAccountRowTransactionAbort(result); }
type ReadyRow = Extract<ProjectAccountRowReadResponseV1, { status: 'present' | 'deleted' | 'absent' }>;
function revisionOf(row: ReadyRow): number { return row.status === 'present' ? row.row.revision : row.status === 'deleted' ? row.revision : -1; }
function plainRefTopology(content: ProjectAccountRowContentV1 | null) {
    if (content?.t !== 'plain' || !('rootPath' in content.v.value)) return null;
    return { rootPath: content.v.value.rootPath, machineId: content.v.value.machineId };
}

/**
 * The Account's private semantic owner submits its admitted graph and reached-ref
 * census. The server enforces their revisions, representation and transaction;
 * E2EE root-change intent remains client-owned because the server cannot open it.
 */
export async function mutateProjectAccountRows(input: Readonly<{ accountId: string; request: ProjectAccountRowMutationRequestV1 }>): Promise<ProjectAccountRowMutationResponseV1> {
    const parsed = ProjectAccountRowMutationRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return { status: 'invalid-request' };
    try {
        return await inTx(async tx => {
            const request = parsed.data;
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
            if (fence.status === 'account_not_found') abort({ status: 'account-not-found' });
            if (fence.status === 'account_inconsistent') abort({ status: 'account-inconsistent', reason: fence.reason });
            const mode = fence.account.currentness.encryptionMode;
            const keys = new Set<string>();
            const current = new Map<string, ReadyRow>();
            const read = async (key: ProjectAccountRowKeyV1): Promise<ReadyRow> => {
                const identity = buildProjectAccountRowPhysicalKeyV1(key);
                const cached = current.get(identity);
                if (cached) return cached;
                const row = await readProjectAccountRowInTx(tx, { accountId: input.accountId, key });
                if (row.status !== 'present' && row.status !== 'absent' && row.status !== 'deleted') abort(row);
                current.set(identity, row);
                return row;
            };
            const checkRevision = (key: ProjectAccountRowKeyV1, row: ReadyRow, expected: number | 'absent') => {
                if (revisionOf(row) !== (expected === 'absent' ? -1 : expected)) abort({ status: 'conflict', key, revision: revisionOf(row) });
            };
            let needsGraph = request.topologyChange;
            let hasGraph = false;
            for (const mutation of request.mutations) {
                const identity = buildProjectAccountRowPhysicalKeyV1(mutation.key);
                if (keys.has(identity)) abort({ status: 'invalid-request' });
                keys.add(identity);
                if (mutation.key.kind === 'relationship-graph') {
                    if (mutation.content === null) abort({ status: 'graph-deletion-forbidden' });
                    hasGraph = true;
                }
                if (mutation.content !== null) {
                    try { assertProjectAccountRowContentForModeV1(mutation.content, mode); }
                    catch { abort({ status: 'account-mode-mismatch' }); }
                    if (mutation.content.t === 'plain') {
                        try { assertProjectAccountRowPayloadBindingV1(mutation.key, mutation.content.v); }
                        catch { abort({ status: 'invalid-stored-content' }); }
                    }
                }
                const row = await read(mutation.key);
                checkRevision(mutation.key, row, mutation.expectedRevision);
                if (mutation.key.kind === 'workspace-ref') {
                    const previous = row.status === 'present' ? plainRefTopology(row.row.content) : null;
                    const next = plainRefTopology(mutation.content);
                    if (mutation.content === null || row.status !== 'present' || (previous && next
                        && (previous.rootPath !== next.rootPath || previous.machineId !== next.machineId))) needsGraph = true;
                }
            }
            if (needsGraph && !hasGraph) abort({ status: 'graph-required' });
            for (const expected of request.expectedRefs) checkRevision(expected.key, await read(expected.key), expected.expectedRevision);
            const rows: ProjectAccountRowV1[] = [];
            let cursor = 0;
            for (const mutation of request.mutations) {
                const result = await mutateReservedAccountScopedKvRowInTx(tx, {
                    accountId: input.accountId, physicalKey: buildProjectAccountRowPhysicalKeyV1(mutation.key),
                    expectedRevision: mutation.expectedRevision, envelope: mutation.content, domain: domainForKey(mutation.key),
                    markChanged: ({ tx, revision }) => markProjectAccountRowChangedInTx(tx, { accountId: input.accountId, key: mutation.key, revision }),
                });
                if (result.status === 'conflict') abort({ ...result, key: mutation.key });
                if (result.status !== 'updated') abort(result);
                cursor = result.cursor;
                rows.push({ key: mutation.key, revision: result.revision, content: mutation.content });
            }
            return { status: 'updated' as const, rows, cursor };
        });
    } catch (error) {
        if (error instanceof ProjectAccountRowTransactionAbort) return error.result;
        throw error;
    }
}
