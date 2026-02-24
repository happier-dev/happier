import { decodeAutomationTemplate } from './automationTemplateCodec';
import { AUTOMATION_TEMPLATE_ENVELOPE_KIND, encodeAutomationTemplateForTransport, tryDecodeAutomationTemplateEnvelope } from './automationTemplateTransport';
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
        throw new Error('Invalid automation template envelope payload');
    }

    const payload = envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND
        ? await params.decryptRaw(envelope.payloadCiphertext)
        : envelope.payload;
    const template = decodeTemplateFromDecryptedRaw(payload);

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

    return await encodeAutomationTemplateForTransport({
        accountMode: envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND ? 'e2ee' : 'plain',
        template: nextTemplate,
        encryptRaw: params.encryptRaw,
    });
}
