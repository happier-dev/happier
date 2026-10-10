import {
    assertAuthoringMemoryContentForModeV1,
    assertAuthoringMemoryValueForKeyV1,
    AuthoringMemoryChangeHintV1Schema,
    AuthoringMemoryContentV1Schema,
    StoredAuthoringMemoryContentV1Schema,
    type AuthoringMemoryContentV1,
    type AuthoringMemoryRowV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { inTx, type Tx } from "@/storage/inTx";
import {
    AUTHORING_MEMORY_ACCOUNT_KV_PREFIX,
    buildAuthoringMemoryPhysicalKey,
    parseAuthoringMemoryPhysicalKey,
} from "./accountScopedKv";
import {
    listReservedAccountScopedKvRowsInTx,
    mutateReservedAccountScopedKvRowInTx,
    readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
    type ReservedAccountScopedKvRowFailure,
    type ReservedAccountScopedKvRowReadResult,
    type ReservedAccountScopedKvRowMutationResult,
} from "./reservedAccountScopedKvRow";

const parseEnvelope = (value: unknown, schema: typeof AuthoringMemoryContentV1Schema): AuthoringMemoryContentV1 | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
};

/** Only this domain's grammar, mode rule and hint vary from the reserved-row owner. */
export const authoringMemoryDomain: ReservedAccountScopedKvRowDomain<AuthoringMemoryContentV1> = Object.freeze({
    label: "Authoring memory",
    parseStoredEnvelope: (value) => parseEnvelope(value, StoredAuthoringMemoryContentV1Schema),
    parseCandidateEnvelope: (value) => parseEnvelope(value, AuthoringMemoryContentV1Schema),
    assertEnvelopeForMode: (envelope, mode) => { assertAuthoringMemoryContentForModeV1(envelope, mode); },
});

function domainForKey(key: string): ReservedAccountScopedKvRowDomain<AuthoringMemoryContentV1> {
    const parse = (value: unknown, schema: typeof AuthoringMemoryContentV1Schema) => {
        const envelope = parseEnvelope(value, schema);
        if (envelope?.t === 'plain') {
            try { assertAuthoringMemoryValueForKeyV1(key, envelope.v); }
            catch { return null; }
        }
        return envelope;
    };
    return {
        ...authoringMemoryDomain,
        parseStoredEnvelope: value => parse(value, StoredAuthoringMemoryContentV1Schema),
        parseCandidateEnvelope: value => parse(value, AuthoringMemoryContentV1Schema),
    };
}

/** Content-free, exact-row invalidation shared with Account encryption migration. */
export async function markAuthoringMemoryChangedInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; key: string; revision: number }>,
): Promise<number> {
    const hint = AuthoringMemoryChangeHintV1Schema.parse({ authoringMemory: true, key: input.key, revision: input.revision });
    return await markAccountChanged(tx, {
        accountId: input.accountId, kind: "account",
        entityId: buildAuthoringMemoryPhysicalKey(input.key), hint,
    });
}

export async function readAuthoringMemoryInTx(tx: Tx, input: Readonly<{ accountId: string; key: string }>): Promise<ReservedAccountScopedKvRowReadResult<AuthoringMemoryContentV1>> {
    return await readReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId, physicalKey: buildAuthoringMemoryPhysicalKey(input.key), domain: domainForKey(input.key),
    });
}

export async function listAuthoringMemoryInTx(
    tx: Tx,
    input: Readonly<{ accountId: string }>,
): Promise<Readonly<{ status: "listed"; rows: readonly AuthoringMemoryRowV1[] }> | ReservedAccountScopedKvRowFailure> {
    const result = await listReservedAccountScopedKvRowsInTx(tx, {
        accountId: input.accountId, physicalPrefix: AUTHORING_MEMORY_ACCOUNT_KV_PREFIX, domain: authoringMemoryDomain,
    });
    if (result.status !== "listed") return result;
    const rows: AuthoringMemoryRowV1[] = [];
    for (const row of result.rows) {
        const key = parseAuthoringMemoryPhysicalKey(row.physicalKey);
        if (key === null) return { status: "invalid-stored-content" };
        if (row.envelope?.t === 'plain') {
            try { assertAuthoringMemoryValueForKeyV1(key, row.envelope.v); }
            catch { return { status: 'invalid-stored-content' }; }
        }
        rows.push({ key, revision: row.revision, content: row.envelope });
    }
    return { status: "listed", rows };
}

/** Per-row CAS and transition admission remain in the shared reserved-row owner. */
export async function mutateAuthoringMemoryInTx(tx: Tx, input: Readonly<{
    accountId: string;
    key: string;
    expectedRevision: number | "absent";
    envelope: AuthoringMemoryContentV1 | null;
}>): Promise<ReservedAccountScopedKvRowMutationResult> {
    return await mutateReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId, physicalKey: buildAuthoringMemoryPhysicalKey(input.key),
        expectedRevision: input.expectedRevision, envelope: input.envelope, domain: domainForKey(input.key),
        markChanged: ({ tx: changeTx, revision }) => markAuthoringMemoryChangedInTx(changeTx, { accountId: input.accountId, key: input.key, revision }),
    });
}

export async function readAuthoringMemory(input: Readonly<{ accountId: string; key: string }>): Promise<ReservedAccountScopedKvRowReadResult<AuthoringMemoryContentV1>> {
    return await inTx(tx => readAuthoringMemoryInTx(tx, input), { readOnly: true });
}
export async function listAuthoringMemory(input: Readonly<{ accountId: string }>): ReturnType<typeof listAuthoringMemoryInTx> {
    return await inTx(tx => listAuthoringMemoryInTx(tx, input), { readOnly: true });
}
export async function mutateAuthoringMemory(input: Parameters<typeof mutateAuthoringMemoryInTx>[1]): Promise<ReservedAccountScopedKvRowMutationResult> {
    return await inTx(tx => mutateAuthoringMemoryInTx(tx, input));
}
