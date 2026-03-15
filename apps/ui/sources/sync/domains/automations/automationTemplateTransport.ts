import { decodeAutomationTemplate, encodeAutomationTemplate } from './automationTemplateCodec';
import type { AutomationTemplate } from './automationTypes';

export const AUTOMATION_TEMPLATE_ENVELOPE_KIND = 'happier_automation_template_encrypted_v1';
export const AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND = 'happier_automation_template_plain_v1';

export type EncryptedAutomationTemplateEnvelope = Readonly<{
    kind: typeof AUTOMATION_TEMPLATE_ENVELOPE_KIND;
    payloadCiphertext: string;
    existingSessionId?: string;
}>;

export type PlainAutomationTemplateEnvelope = Readonly<{
    kind: typeof AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND;
    payload: unknown;
    existingSessionId?: string;
}>;

export type AutomationTemplateEnvelope =
    | EncryptedAutomationTemplateEnvelope
    | PlainAutomationTemplateEnvelope;

function tryParseEnvelope(payload: string): AutomationTemplateEnvelope | null {
    if (typeof payload !== 'string') return null;
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') return null;
        const kind = (parsed as any).kind;
        if (kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND) {
            if (typeof (parsed as any).payloadCiphertext !== 'string') return null;
            const existingSessionId = typeof (parsed as any).existingSessionId === 'string'
                ? (parsed as any).existingSessionId
                : undefined;
            return {
                kind: AUTOMATION_TEMPLATE_ENVELOPE_KIND,
                payloadCiphertext: (parsed as any).payloadCiphertext,
                ...(existingSessionId ? { existingSessionId } : {}),
            };
        }
        if (kind === AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND) {
            const existingSessionId = typeof (parsed as any).existingSessionId === 'string'
                ? (parsed as any).existingSessionId
                : undefined;
            return {
                kind: AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND,
                payload: (parsed as any).payload,
                ...(existingSessionId ? { existingSessionId } : {}),
            };
        }
        return null;
    } catch {
        return null;
    }
}

function normalizeExistingSessionId(input: string | undefined): string | undefined {
    if (typeof input !== 'string') return undefined;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function tryReadAutomationTemplateEnvelopeExistingSessionId(templateCiphertext: string): string | null {
    const envelope = tryParseEnvelope(templateCiphertext);
    const id = normalizeExistingSessionId(envelope?.existingSessionId);
    return id ?? null;
}

export function tryDecodeAutomationTemplateEnvelope(templateCiphertext: string): AutomationTemplateEnvelope | null {
    return tryParseEnvelope(templateCiphertext);
}

export function tryReadAutomationTemplateEnvelopePayloadCiphertext(templateCiphertext: string): string | null {
    const envelope = tryParseEnvelope(templateCiphertext);
    if (envelope?.kind !== AUTOMATION_TEMPLATE_ENVELOPE_KIND) return null;
    return typeof envelope.payloadCiphertext === 'string' && envelope.payloadCiphertext.trim().length > 0
        ? envelope.payloadCiphertext
        : null;
}

export async function encodeAutomationTemplateForTransport(params: {
    accountMode: 'plain' | 'e2ee';
    template: AutomationTemplate;
    encryptRaw?: (value: unknown) => Promise<string>;
}): Promise<string> {
    const encoded = encodeAutomationTemplate(params.template);
    const parsed = decodeAutomationTemplate(encoded);
    if (!parsed) {
        throw new Error('Failed to normalize automation template before transport encoding');
    }

    const requiresSensitiveEncryption =
        typeof (parsed as any).sessionEncryptionKeyBase64 === 'string' &&
        String((parsed as any).sessionEncryptionKeyBase64).trim().length > 0;

    if (params.accountMode === 'plain' && !requiresSensitiveEncryption) {
        const envelope: PlainAutomationTemplateEnvelope = {
            kind: AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND,
            payload: parsed,
            ...(normalizeExistingSessionId(parsed.existingSessionId)
                ? { existingSessionId: normalizeExistingSessionId(parsed.existingSessionId) }
                : {}),
        };
        return JSON.stringify(envelope);
    }

    if (typeof params.encryptRaw !== 'function') {
        throw new Error('encryptRaw is required to encode encrypted automation templates');
    }

    const payloadCiphertext = await params.encryptRaw(parsed);
    const envelope: EncryptedAutomationTemplateEnvelope = {
        kind: AUTOMATION_TEMPLATE_ENVELOPE_KIND,
        payloadCiphertext,
        ...(normalizeExistingSessionId(parsed.existingSessionId)
            ? { existingSessionId: normalizeExistingSessionId(parsed.existingSessionId) }
            : {}),
    };
    return JSON.stringify(envelope);
}

export async function sealAutomationTemplateForTransport(params: {
    template: AutomationTemplate;
    encryptRaw: (value: unknown) => Promise<string>;
}): Promise<string> {
    return await encodeAutomationTemplateForTransport({
        accountMode: 'e2ee',
        template: params.template,
        encryptRaw: params.encryptRaw,
    });
}
