import {
    projectAutomationAccountCurrentnessWitnessV1,
    type AutomationAccountCurrentnessWitnessV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { deriveAccountEncryptionMigrationKeyFingerprints } from "@/app/encryption/accountEncryptionTransition";
import type { Tx } from "@/storage/inTx";

/**
 * The one Automation-facing projection of Account currentness. Claim, start,
 * settlement, and reply handoff must derive the same witness from the Account
 * row rather than each carrying a slightly different private select or
 * comparison.
 */
export const automationAccountCurrentnessSelect = {
    seq: true,
    publicKey: true,
    encryptionMode: true,
    contentPublicKey: true,
    contentPublicKeySig: true,
} satisfies Prisma.AccountSelect;

type AutomationAccountCurrentnessRow = Prisma.AccountGetPayload<{
    select: typeof automationAccountCurrentnessSelect;
}>;

export function deriveAutomationAccountCurrentnessWitness(
    account: AutomationAccountCurrentnessRow,
): AutomationAccountCurrentnessWitnessV1 | null {
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== "ready") return null;

    const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
    // A supported Account migrated e2ee -> plain retains `contentPublicKey`, so
    // this row still reports a content-key fingerprint. The shared projection
    // owner normalizes the keyless plain witness for every reader.
    return projectAutomationAccountCurrentnessWitnessV1({
        mode: currentness.currentness.encryptionMode,
        version: account.seq,
        contentKeyFingerprint: fingerprints.contentKeyFingerprint,
    });
}

export async function fetchAutomationAccountCurrentnessWitnessTx(
    tx: Tx,
    accountId: string,
): Promise<AutomationAccountCurrentnessWitnessV1 | null> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: automationAccountCurrentnessSelect,
    });
    return account ? deriveAutomationAccountCurrentnessWitness(account) : null;
}
