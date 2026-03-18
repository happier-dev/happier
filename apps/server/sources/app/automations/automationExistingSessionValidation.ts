import type { Tx } from "@/storage/inTx";
import { evaluateVendorResumeEligibility, inferAgentIdFromSessionMetadata } from "@happier-dev/agents";

import type { AutomationTargetType } from "./automationTypes";
import { AutomationValidationError } from "./automationValidation";

type ExistingSessionTemplate = Readonly<{
    existingSessionId: string;
}>;

function parseExistingSessionTemplate(templateCiphertext: string): ExistingSessionTemplate {
    let parsed: unknown;
    try {
        parsed = JSON.parse(templateCiphertext);
    } catch {
        throw new AutomationValidationError("existing_session automation template must be valid JSON");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new AutomationValidationError("existing_session automation template must be an object");
    }

    const existingSessionId = typeof (parsed as Record<string, unknown>).existingSessionId === "string"
        ? (parsed as Record<string, string>).existingSessionId.trim()
        : "";
    if (!existingSessionId) {
        throw new AutomationValidationError("existing_session automation template must include existingSessionId");
    }

    return { existingSessionId };
}

type ParsedSessionMetadata = Readonly<
    | {
        ok: true;
        value: unknown;
    }
    | {
        ok: false;
    }
>;

function parseSessionMetadata(metadata: string): ParsedSessionMetadata {
    try {
        return { ok: true, value: JSON.parse(metadata) };
    } catch {
        return { ok: false };
    }
}

function isExistingSessionTargetResumable(session: Readonly<{
    encryptionMode: string | null;
    metadata: string | null;
    active: boolean;
}>): boolean {
    if (!session.active) {
        return false;
    }

    const encryptionMode = session.encryptionMode === "plain" || session.encryptionMode === "e2ee"
        ? session.encryptionMode
        : null;
    if (!encryptionMode) {
        return false;
    }

    const metadata = typeof session.metadata === "string" ? session.metadata.trim() : "";
    if (!metadata) {
        return false;
    }

    const parsedMetadata = parseSessionMetadata(metadata);
    if (!parsedMetadata.ok) {
        return encryptionMode === "e2ee";
    }

    const agentId = inferAgentIdFromSessionMetadata(parsedMetadata.value);
    return evaluateVendorResumeEligibility({
        agentId,
        metadata: parsedMetadata.value,
    }).eligible;
}

export async function validateExistingSessionAutomationTargetTx(params: {
    tx: Tx;
    accountId: string;
    targetType: AutomationTargetType;
    templateCiphertext: string;
}): Promise<void> {
    if (params.targetType !== "existing_session") {
        return;
    }

    const template = parseExistingSessionTemplate(params.templateCiphertext);
    const session = await params.tx.session.findFirst({
        where: {
            id: template.existingSessionId,
            accountId: params.accountId,
        },
        select: {
            id: true,
            active: true,
            encryptionMode: true,
            metadata: true,
        },
    });
    if (!session) {
        throw new AutomationValidationError("existing session target does not exist");
    }
    if (!session.active) {
        throw new AutomationValidationError("existing session target is inactive");
    }
    if (!isExistingSessionTargetResumable(session)) {
        throw new AutomationValidationError("existing session target is not resumable");
    }
}
