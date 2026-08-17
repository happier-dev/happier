import { decodeAutomationTemplate } from './automationTemplateCodec';
import { AUTOMATION_TEMPLATE_ENVELOPE_KIND, encodeAutomationTemplateForTransport, resolveAutomationTemplatePayload } from './automationTemplateTransport';
import { AutomationTemplateEncryptionMaterialUnavailableError } from './automationTemplateAvailability';
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
    decryptRaw?: (payloadCiphertext: string) => Promise<unknown | null>;
    encryptRaw?: (value: unknown) => Promise<string>;
    fallbackDraft?: SessionAuthoringDraft;
}): Promise<string> {
    const payload = await resolveAutomationTemplatePayload({
        templateCiphertext: params.templateCiphertext,
        decryptRaw: params.decryptRaw,
    });
    if (payload.kind === 'invalid') {
        throw new Error('Invalid automation template envelope payload');
    }
    if (payload.kind === 'locked') {
        throw new AutomationTemplateEncryptionMaterialUnavailableError();
    }
    const template = decodeTemplateFromDecryptedRaw(payload.payload);

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

    try {
        return await encodeAutomationTemplateForTransport({
            accountMode: payload.envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND ? 'e2ee' : 'plain',
            template: nextTemplate,
            ...(params.encryptRaw ? { encryptRaw: params.encryptRaw } : {}),
        });
    } catch (error) {
        if (
            error instanceof Error
            && error.message === 'encryptRaw is required to encode encrypted automation templates'
        ) {
            throw new AutomationTemplateEncryptionMaterialUnavailableError();
        }
        throw error;
    }
}
