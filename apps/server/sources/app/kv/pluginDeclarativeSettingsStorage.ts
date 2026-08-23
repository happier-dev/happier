import {
    assertPluginAccountSettingsContentForModeV1,
    PluginAccountSettingsContentV1Schema,
    PluginAccountSettingsMutationRequestV1Schema,
    type PluginAccountSettingsContentV1,
} from "@happier-dev/protocol";
import {
    buildPluginDomainAccountChangeEntityId,
} from "@happier-dev/protocol/changes";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { inTx, type Tx } from "@/storage/inTx";

import { buildPluginDeclarativeSettingsPhysicalKey } from "./accountScopedKv";
import {
    mutateReservedAccountScopedKvRowInTx,
    readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
    type ReservedAccountScopedKvRowMutationResult,
    type ReservedAccountScopedKvRowReadResult,
} from "./reservedAccountScopedKvRow";

export type PluginDeclarativeSettingsEnvelope = PluginAccountSettingsContentV1;

export type PluginDeclarativeSettingsReadResult =
    ReservedAccountScopedKvRowReadResult<PluginDeclarativeSettingsEnvelope>;

export type PluginDeclarativeSettingsMutation = Readonly<{
    accountId: string;
    pluginId: string;
    /** `absent` names a never-created row; a tombstone must use its revision. */
    expectedRevision: number | "absent";
    /** `null` creates a versioned tombstone without exposing prior content. */
    envelope: PluginDeclarativeSettingsEnvelope | null;
}>;

export type PluginDeclarativeSettingsMutationResult = ReservedAccountScopedKvRowMutationResult;

/**
 * Declarative Settings' own semantics: its content grammar and the
 * Account-mode rule for that grammar. Field, default, and secret semantics
 * stay with the Settings owner; the Account-row protocol underneath belongs to
 * the reserved Account-scoped row owner.
 */
const pluginDeclarativeSettingsDomain: ReservedAccountScopedKvRowDomain<PluginDeclarativeSettingsEnvelope> =
    Object.freeze({
        label: "Plugin declarative Settings",
        // A stored record may predate the current ciphertext bound and must
        // stay readable; a new candidate must satisfy the writer grammar.
        parseStoredEnvelope: (value: unknown) => {
            const parsed = PluginAccountSettingsContentV1Schema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
        parseCandidateEnvelope: (value: unknown) => {
            const parsed = PluginAccountSettingsMutationRequestV1Schema
                .shape.content.safeParse(value);
            return parsed.success && parsed.data !== null ? parsed.data : null;
        },
        assertEnvelopeForMode: (envelope, mode) => {
            assertPluginAccountSettingsContentForModeV1(envelope, mode);
        },
    });

/**
 * Reserved, server-internal Settings record port. It intentionally exposes a
 * mode-checked envelope and CAS revision only: field/default/secret semantics
 * remain with the Settings owner, and AccountChange never carries the envelope.
 */
export async function readPluginDeclarativeSettingsInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginDeclarativeSettingsReadResult> {
    return await readReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId,
        physicalKey: buildPluginDeclarativeSettingsPhysicalKey(input.pluginId),
        domain: pluginDeclarativeSettingsDomain,
    });
}

export async function readPluginDeclarativeSettings(
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginDeclarativeSettingsReadResult> {
    return await inTx(async (tx) =>
        await readPluginDeclarativeSettingsInTx(tx, input));
}

export async function mutatePluginDeclarativeSettingsInTx(
    tx: Tx,
    input: PluginDeclarativeSettingsMutation,
): Promise<PluginDeclarativeSettingsMutationResult> {
    return await mutateReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId,
        physicalKey: buildPluginDeclarativeSettingsPhysicalKey(input.pluginId),
        expectedRevision: input.expectedRevision,
        envelope: input.envelope,
        domain: pluginDeclarativeSettingsDomain,
        markChanged: async ({ tx: changeTx, revision }) => {
            const hint = {
                pluginDomain: "settings" as const,
                pluginId: input.pluginId,
                scope: "account" as const,
                revision,
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

export async function mutatePluginDeclarativeSettings(
    input: PluginDeclarativeSettingsMutation,
): Promise<PluginDeclarativeSettingsMutationResult> {
    return await inTx(async (tx) =>
        await mutatePluginDeclarativeSettingsInTx(tx, input));
}
