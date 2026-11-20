import { createHash } from "node:crypto";
import { z } from "zod/mini";
import { createStoredReadSchema } from "@happier-dev/protocol/json/storedReadSchema";
import {
    serializeSessionInputRequestEqualityIntentV1,
    SessionInputRequestEnvelopeDigestV1Schema,
    SessionInputRequestEqualityEvidenceV1Schema,
    type SessionInputRequestEqualityEvidenceV1,
} from "@happier-dev/protocol/sessions/messages/sessionInputAdmission";
import type { PendingRequestedActionV1 } from "@happier-dev/protocol/sessions/pending/pendingRequestedActionV1";

const AccountEncryptedRequestDigestSchema = z.strictObject({
    kind: z.literal("accountEncryptedRequestDigest"),
    digest: SessionInputRequestEnvelopeDigestV1Schema,
});

export const StoredPendingRequestEqualityEvidenceV1Schema = createStoredReadSchema(z.union([
    SessionInputRequestEqualityEvidenceV1Schema,
    AccountEncryptedRequestDigestSchema,
]));

export type StoredPendingRequestEqualityEvidenceV1 = z.infer<typeof StoredPendingRequestEqualityEvidenceV1Schema>;

type PendingInputRequest = Readonly<{
    content: PrismaJson.SessionMessageContent;
    requestedAction: PendingRequestedActionV1;
}>;

function digestRequest({ content, requestedAction }: PendingInputRequest): string {
    return createHash("sha256")
        .update(serializeSessionInputRequestEqualityIntentV1({ requestEnvelope: content, requestedAction }), "utf8")
        .digest("base64url");
}

export function derivePlainRequestEqualityEvidence(request: PendingInputRequest): SessionInputRequestEqualityEvidenceV1 | undefined {
    if (request.content.t !== "plain") return undefined;
    return { kind: "plainDigest", digest: digestRequest(request) };
}

/** Home hashes the original opaque envelope before the host replaces it. */
export function deriveAccountEncryptedRequestDigest(request: PendingInputRequest): z.infer<typeof AccountEncryptedRequestDigestSchema> | undefined {
    if (request.content.t !== "encrypted") return undefined;
    return { kind: "accountEncryptedRequestDigest", digest: digestRequest(request) };
}

export function matchesAccountEncryptedRequestDigest(
    evidence: StoredPendingRequestEqualityEvidenceV1 | undefined,
    request: PendingInputRequest,
): boolean {
    return evidence?.kind === "accountEncryptedRequestDigest" && request.content.t === "encrypted"
        && digestRequest(request) === evidence.digest;
}
