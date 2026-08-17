import type { Tx } from "@/storage/inTx";
import { evaluateExistingSessionAutomationEligibility } from "@happier-dev/agents";
import { openPlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";
import {
    AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    AutomationTemplateEnvelopeSchema,
    LegacyEncryptedAutomationTemplateEnvelopeSchema,
    LegacyPlainAutomationTemplateEnvelopeSchema,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
    type AutomationTemplateEnvelope,
} from "@happier-dev/protocol";

import type { AutomationTargetType } from "./automationTypes";
import { AutomationValidationError } from "./automationValidation";
import {
    parsePersistedSessionOwnerMetadataEnvelopeV1,
} from "@/app/session/metadata/sessionOwnerMetadataPersistence";

type ExistingSessionTemplate = Readonly<{
    existingSessionId: string | null;
    envelopeKind: AutomationTemplateEnvelope["kind"] | null;
}>;

function isOpaqueStoredSessionMetadata(params: Readonly<{
    encryptionMode: string;
    metadata: string;
}>): boolean {
    if (params.encryptionMode !== "e2ee") {
        return false;
    }

    try {
        const parsed = JSON.parse(params.metadata);
        return !parsed || typeof parsed !== "object" || Array.isArray(parsed);
    } catch {
        return true;
    }
}

function parseExistingSessionTemplate(params: Readonly<{
    templateCiphertext: string;
    legacyExistingSessionId?: string;
}>): ExistingSessionTemplate {
    let parsed: unknown;
    try {
        parsed = JSON.parse(params.templateCiphertext);
    } catch {
        throw new AutomationValidationError("existing_session automation template must be valid JSON");
    }

    const currentEnvelope = AutomationTemplateEnvelopeSchema.safeParse(parsed);
    if (!currentEnvelope.success && params.legacyExistingSessionId) {
        const predecessor = LegacyEncryptedAutomationTemplateEnvelopeSchema.safeParse(parsed);
        if (
            predecessor.success
            && predecessor.data.existingSessionId === params.legacyExistingSessionId
        ) {
            return {
                existingSessionId: params.legacyExistingSessionId,
                envelopeKind: predecessor.data.kind,
            };
        }
        const plainPredecessor = LegacyPlainAutomationTemplateEnvelopeSchema.safeParse(parsed);
        const payloadExistingSessionId = plainPredecessor.success
            && plainPredecessor.data.payload
            && typeof plainPredecessor.data.payload === "object"
            && !Array.isArray(plainPredecessor.data.payload)
            && typeof (plainPredecessor.data.payload as Record<string, unknown>).existingSessionId === "string"
                ? (plainPredecessor.data.payload as Record<string, string>).existingSessionId.trim()
                : "";
        if (
            plainPredecessor.success
            && plainPredecessor.data.existingSessionId === params.legacyExistingSessionId
            && payloadExistingSessionId === params.legacyExistingSessionId
        ) {
            return {
                existingSessionId: params.legacyExistingSessionId,
                envelopeKind: plainPredecessor.data.kind,
            };
        }
    }
    const envelope = currentEnvelope;
    if (!envelope.success) {
        throw new AutomationValidationError("existing_session automation template envelope is invalid");
    }

    if (envelope.data.kind === AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND) {
        return {
            existingSessionId: null,
            envelopeKind: envelope.data.kind,
        };
    }

    const existingSessionId = envelope.data.payload
        && typeof envelope.data.payload === "object"
        && !Array.isArray(envelope.data.payload)
        && typeof (envelope.data.payload as Record<string, unknown>).existingSessionId === "string"
            ? (envelope.data.payload as Record<string, string>).existingSessionId.trim()
            : "";
    if (!existingSessionId) {
        throw new AutomationValidationError("existing_session automation template must include existingSessionId");
    }

    return {
        existingSessionId,
        envelopeKind: envelope.data.kind,
    };
}

export async function validateExistingSessionAutomationTargetTx(params: {
    tx: Tx;
    accountId: string;
    targetType: AutomationTargetType;
    /**
     * Retained raw-template admission. Current strict recipes supply the
     * already schema-owned target identity below instead of reparsing a
     * second template representation here.
     */
    templateCiphertext?: string;
    strictExistingSessionId?: string;
    accountMode?: "e2ee" | "plain";
    legacyExistingSessionId?: string;
}): Promise<void> {
    if (params.targetType !== "existing_session") {
        return;
    }

    const template = params.strictExistingSessionId === undefined
        ? (() => {
            if (typeof params.templateCiphertext !== "string") {
                throw new AutomationValidationError("existing_session automation template is missing");
            }
            return parseExistingSessionTemplate({
                templateCiphertext: params.templateCiphertext,
                legacyExistingSessionId: params.legacyExistingSessionId,
            });
        })()
        : {
            existingSessionId: params.strictExistingSessionId,
            envelopeKind: null,
        };
    if (!template.existingSessionId) {
        // Existing-session identity stays in the authenticated E2EE payload.
        // The server must neither disclose nor validate that private content.
        return;
    }
    const session = await params.tx.session.findFirst({
        where: {
            id: template.existingSessionId,
            accountId: params.accountId,
        },
        select: {
            id: true,
            encryptionMode: true,
            metadata: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
        },
    });
    if (!session) {
        throw new AutomationValidationError("existing session target does not exist");
    }
    if (
        params.accountMode === "plain"
        && template.envelopeKind === AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND
        && session.encryptionMode !== "e2ee"
    ) {
        throw new AutomationValidationError(
            "encrypted templates in a plain account require an e2ee existing session",
        );
    }
    if (session.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
        const ownerEnvelope = params.accountMode
            ? parsePersistedSessionOwnerMetadataEnvelopeV1({
                metadataLayoutVersion:
                    session.metadataLayoutVersion,
                accountMode: params.accountMode,
                ownerMetadata: session.ownerMetadata,
                allowRetainedDevelopmentCiphertext: false,
            })
            : null;
        if (
            !ownerEnvelope
            || !params.accountMode
            || !validateSessionOwnerMetadataEnvelopeForAccountModeV1({
                accountMode: params.accountMode,
                envelope: ownerEnvelope,
            }).ok
        ) {
            throw new AutomationValidationError("existing session target metadata privacy upgrade required");
        }
        // The server deliberately cannot open account-scoped owner metadata.
        // A future owner-authenticated proof may supply this decision; shared
        // metadata is never a resume/control authority substitute.
        throw new AutomationValidationError("existing session target owner metadata is unavailable");
    }
    if (session.metadataLayoutVersion !== 0) {
        throw new AutomationValidationError("existing session target metadata privacy upgrade required");
    }
    const account = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: { settings: true },
    });
    if (isOpaqueStoredSessionMetadata({
        encryptionMode: session.encryptionMode,
        metadata: session.metadata,
    })) {
        return;
    }
    const accountSettingsEnvelope = openPlainAccountSettingsDbValue({
        accountId: params.accountId,
        dbValue: account?.settings ?? null,
    });
    const eligibility = evaluateExistingSessionAutomationEligibility({
        metadata: session.metadata,
        accountSettings: accountSettingsEnvelope?.t === "plain" && accountSettingsEnvelope.v && typeof accountSettingsEnvelope.v === "object"
            ? accountSettingsEnvelope.v as Record<string, unknown>
            : null,
    });
    if (!eligibility.eligible) {
        throw new AutomationValidationError("existing session target is not resumable");
    }
}
