import { decodeAutomationTemplate } from './automationTemplateCodec';
import { AUTOMATION_TEMPLATE_ENVELOPE_KIND, encodeAutomationTemplateForTransport, tryDecodeAutomationTemplateEnvelope } from './automationTemplateTransport';
import type { AutomationTemplate } from './automationTypes';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    hydrateSessionAuthoringDraftFromAutomationTemplate,
    mergeExistingSessionAuthoringDraftInheritedFields,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';

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
    draft?: SessionAuthoringDraft;
    decryptRaw: (payloadCiphertext: string) => Promise<unknown | null>;
    encryptRaw: (value: unknown) => Promise<string>;
    fallbackDraft?: SessionAuthoringDraft;
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
    const baseDraft = mergeExistingSessionAuthoringDraftInheritedFields(
        hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'existing_session',
            template,
        }),
        params.fallbackDraft,
    );
    const nextDraft = mergeExistingSessionAuthoringDraftInheritedFields(
        params.draft ? {
            ...params.draft,
            targetType: 'existing_session',
        } : {
            ...baseDraft,
            prompt: message,
            displayText: message,
        },
        baseDraft,
    );
    const nextMessage = normalizeMessage(nextDraft.prompt || nextDraft.displayText);
    const nextTemplate: AutomationTemplate = buildAutomationTemplateFromSessionAuthoringDraft({
        ...nextDraft,
        prompt: nextMessage,
        displayText: nextMessage,
    });

    return await encodeAutomationTemplateForTransport({
        accountMode: envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND ? 'e2ee' : 'plain',
        template: nextTemplate,
        encryptRaw: params.encryptRaw,
    });
}
