import type { Tx } from "@/storage/inTx";
import { evaluateExistingSessionAutomationEligibility } from "@happier-dev/agents";
import { openPlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";

import type { AutomationTargetType } from "./automationTypes";
import { AutomationValidationError } from "./automationValidation";

type ExistingSessionTemplate = Readonly<{
    existingSessionId: string;
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
            encryptionMode: true,
            metadata: true,
        },
    });
    const account = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: { settings: true },
    });
    if (!session) {
        throw new AutomationValidationError("existing session target does not exist");
    }
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
