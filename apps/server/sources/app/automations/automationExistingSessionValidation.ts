import type { Tx } from "@/storage/inTx";

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
        },
    });
    if (!session) {
        throw new AutomationValidationError("existing session target does not exist");
    }
    if (!session.active) {
        throw new AutomationValidationError("existing session target is inactive");
    }
}
