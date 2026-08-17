import {
    SessionOrganizationContentEnvelopeSchema,
    type SessionOrganizationContentEnvelope,
} from "@happier-dev/protocol";

import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import type { SessionOrganizationTx } from "./types";

export type SessionOrganizationDisplayEnvelopeParseResult =
    | Readonly<{
        status: "ready";
        display: SessionOrganizationContentEnvelope | null;
    }>
    | Readonly<{
        status: "unreadable";
        reason: "invalid_stored_display";
    }>;

export async function isSessionOrganizationDisplayEnvelopeAllowedForAccount(params: Readonly<{
    tx: SessionOrganizationTx;
    accountId: string;
    display: SessionOrganizationContentEnvelope | null;
}>): Promise<boolean> {
    return await areSessionOrganizationDisplayEnvelopesAllowedForAccount({
        tx: params.tx,
        accountId: params.accountId,
        displays: [params.display],
    });
}

export async function areSessionOrganizationDisplayEnvelopesAllowedForAccount(params: Readonly<{
    tx: SessionOrganizationTx;
    accountId: string;
    displays: readonly (SessionOrganizationContentEnvelope | null)[];
}>): Promise<boolean> {
    if (!params.displays.some((display) => display !== null)) {
        return true;
    }

    const account = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) return false;
    const currentness =
        deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status === "inconsistent") return false;
    const expectedEnvelopeType =
        currentness.currentness.encryptionMode === "plain"
            ? "plain"
            : "encrypted";
    return params.displays.every((display) => (
        display === null || display.t === expectedEnvelopeType
    ));
}

export function serializeSessionOrganizationDisplayEnvelope(
    display: SessionOrganizationContentEnvelope | null,
): string | null {
    if (display === null) return null;
    return JSON.stringify(SessionOrganizationContentEnvelopeSchema.parse(display));
}

export function parseSessionOrganizationDisplayEnvelope(
    value: string | null,
): SessionOrganizationDisplayEnvelopeParseResult {
    if (!value) {
        return {
            status: "ready",
            display: null,
        };
    }
    try {
        const parsed =
            SessionOrganizationContentEnvelopeSchema.safeParse(
                JSON.parse(value),
            );
        return parsed.success
            ? { status: "ready", display: parsed.data }
            : {
                status: "unreadable",
                reason: "invalid_stored_display",
            };
    } catch {
        return {
            status: "unreadable",
            reason: "invalid_stored_display",
        };
    }
}
