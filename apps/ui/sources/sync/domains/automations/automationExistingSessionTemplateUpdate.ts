import { decodeAutomationTemplate } from './automationTemplateCodec';
import { sealAutomationTemplateForTransport, tryDecodeAutomationTemplateEnvelope } from './automationTemplateTransport';
import type { AutomationTemplate } from './automationTypes';

function normalizeMessage(input: string): string {
    const normalized = typeof input === 'string' ? input.trim() : '';
    if (!normalized) {
        throw new Error('Message cannot be empty');
    }
    return normalized;
}

function decodeTemplateFromDecryptedRaw(raw: unknown): AutomationTemplate {
    const decoded = decodeAutomationTemplate(JSON.stringify(raw));
    if (!decoded) {
        throw new Error('Invalid decrypted automation template payload');
    }
    return decoded;
}

export async function updateExistingSessionAutomationTemplateMessage(params: {
    templateCiphertext: string;
    message: string;
    decryptRaw: (payloadCiphertext: string) => Promise<unknown | null>;
    encryptRaw: (value: unknown) => Promise<string>;
}): Promise<string> {
    const envelope = tryDecodeAutomationTemplateEnvelope(params.templateCiphertext);
    if (!envelope) {
        throw new Error('Invalid encrypted automation template envelope payload');
    }

    const decrypted = await params.decryptRaw(envelope.payloadCiphertext);
    const template = decodeTemplateFromDecryptedRaw(decrypted);

    const existingSessionId = template.existingSessionId?.trim() ?? '';
    if (!existingSessionId) {
        throw new Error('Existing-session automations require existingSessionId');
    }

    const message = normalizeMessage(params.message);
    const nextTemplate: AutomationTemplate = {
        ...template,
        prompt: message,
        displayText: message,
    };

    return sealAutomationTemplateForTransport({
        template: nextTemplate,
        encryptRaw: params.encryptRaw,
    });
}

