import {
    assertPluginAccountStorageEnvelopeForModeV1,
    PluginAccountStorageEnvelopeV1Schema,
    type PluginAccountStorageEnvelopeV1,
} from "@happier-dev/protocol";
import {
    buildPluginDomainAccountChangeEntityId,
} from "@happier-dev/protocol/changes";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { inTx, type Tx } from "@/storage/inTx";

import { buildPluginAccountStoragePhysicalKey } from "./accountScopedKv";
import {
    mutateReservedAccountScopedKvRowInTx,
    readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
    type ReservedAccountScopedKvRowMutationResult,
    type ReservedAccountScopedKvRowReadResult,
} from "./reservedAccountScopedKvRow";

export type PluginAccountStorageReadResult =
    ReservedAccountScopedKvRowReadResult<PluginAccountStorageEnvelopeV1>;

export type PluginAccountStorageMutation = Readonly<{
    accountId: string;
    pluginId: string;
    /** `absent` names a never-created row; a tombstone needs its revision. */
    expectedRevision: number | "absent";
    /** `null` creates a versioned tombstone without returning old content. */
    envelope: PluginAccountStorageEnvelopeV1 | null;
}>;

export type PluginAccountStorageMutationResult = ReservedAccountScopedKvRowMutationResult;

/**
 * Account KV's own semantics: its envelope grammar and the Account-mode rule
 * for that grammar. Account existence, encryption currentness, the transition
 * fence, revision compare-and-set, and stored-row re-validation belong to the
 * reserved Account-scoped row owner and are not restated here.
 */
function parsePluginAccountStorageEnvelope(value: unknown): PluginAccountStorageEnvelopeV1 | null {
    const parsed = PluginAccountStorageEnvelopeV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

const pluginAccountStorageDomain: ReservedAccountScopedKvRowDomain<PluginAccountStorageEnvelopeV1> =
    Object.freeze({
        label: "Plugin Account KV",
        // Account KV publishes one envelope grammar: its ciphertext bound is
        // part of the stored shape, so reads and candidates share it.
        parseStoredEnvelope: parsePluginAccountStorageEnvelope,
        parseCandidateEnvelope: parsePluginAccountStorageEnvelope,
        assertEnvelopeForMode: (envelope, mode) => {
            assertPluginAccountStorageEnvelopeForModeV1(envelope, mode);
        },
    });

/**
 * The one server owner for a plugin's Account-KV row. It intentionally moves
 * whole opaque envelopes only; logical-key transactions stay in the bound host
 * adapter, so E2EE never introduces server-visible logical data or a second
 * per-key persistence owner.
 */
export async function readPluginAccountStorageInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginAccountStorageReadResult> {
    return await readReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId,
        physicalKey: buildPluginAccountStoragePhysicalKey(input.pluginId),
        domain: pluginAccountStorageDomain,
    });
}

export async function readPluginAccountStorage(
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginAccountStorageReadResult> {
    return await inTx(async (tx) => await readPluginAccountStorageInTx(tx, input));
}

export async function mutatePluginAccountStorageInTx(
    tx: Tx,
    input: PluginAccountStorageMutation,
): Promise<PluginAccountStorageMutationResult> {
    return await mutateReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId,
        physicalKey: buildPluginAccountStoragePhysicalKey(input.pluginId),
        expectedRevision: input.expectedRevision,
        envelope: input.envelope,
        domain: pluginAccountStorageDomain,
        markChanged: async ({ tx: changeTx }) => {
            const hint = {
                pluginDomain: "dataKv" as const,
                pluginId: input.pluginId,
                full: true as const,
            };
            return await markAccountChanged(changeTx, {
                accountId: input.accountId,
                kind: "pluginDomain",
                entityId: buildPluginDomainAccountChangeEntityId(hint),
                hint,
            });
        },
    });
}

export async function mutatePluginAccountStorage(
    input: PluginAccountStorageMutation,
): Promise<PluginAccountStorageMutationResult> {
    return await inTx(async (tx) => await mutatePluginAccountStorageInTx(tx, input));
}
