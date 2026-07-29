import {
    SessionOrganizationContentEnvelopeSchema,
    type SessionOrganizationContentEnvelope,
} from "@happier-dev/protocol";

import type { SessionOrganizationTx } from "./types";

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
    if (!params.displays.some((display) => display?.t === "plain")) return true;

    const account = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: { encryptionMode: true },
    });
    return account?.encryptionMode === "plain";
}

export function serializeSessionOrganizationDisplayEnvelope(
    display: SessionOrganizationContentEnvelope | null,
): string | null {
    if (display === null) return null;
    return JSON.stringify(SessionOrganizationContentEnvelopeSchema.parse(display));
}

export function parseSessionOrganizationDisplayEnvelope(
    value: string | null,
): SessionOrganizationContentEnvelope | null {
    if (!value) return null;
    const parsed = SessionOrganizationContentEnvelopeSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
}
