import { decodeAutomationTemplate, encodeAutomationTemplate } from './automationTemplateCodec';
import type { AutomationTemplate } from './automationTypes';
import {
    AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
    AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
    normalizeAutomationTemplateEnvelopeStoredRead,
    type AutomationTemplateEnvelope,
    type EncryptedAutomationTemplateEnvelope,
    type PlainAutomationTemplateEnvelope,
} from '@happier-dev/protocol';

export const AUTOMATION_TEMPLATE_ENVELOPE_KIND =
    AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND;
export const AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND =
    AUTOMATION_TEMPLATE_PLAIN_V1_KIND;
export type {
    AutomationTemplateEnvelope,
    EncryptedAutomationTemplateEnvelope,
    PlainAutomationTemplateEnvelope,
};

export type AutomationTemplatePayloadResolution =
    | Readonly<{
        kind: 'ready';
        envelope: AutomationTemplateEnvelope;
        payload: unknown;
    }>
    | Readonly<{
        kind: 'locked';
        reason: 'encryption_material_unavailable';
    }>
    | Readonly<{
        kind: 'invalid';
    }>;

function tryParseStoredEnvelope(payload: string) {
    if (typeof payload !== 'string') return null;
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        return normalizeAutomationTemplateEnvelopeStoredRead(parsed);
    } catch {
        return null;
    }
}

function tryParseEnvelope(payload: string): AutomationTemplateEnvelope | null {
    return tryParseStoredEnvelope(payload)?.envelope ?? null;
}

function normalizeExistingSessionId(input: unknown): string | undefined {
    if (typeof input !== 'string') return undefined;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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

export async function resolveAutomationTemplatePayload(params: Readonly<{
    templateCiphertext: string;
    decryptRaw?: (payloadCiphertext: string) => Promise<unknown | null>;
}>): Promise<AutomationTemplatePayloadResolution> {
    const storedRead = tryParseStoredEnvelope(params.templateCiphertext);
    if (!storedRead) return { kind: 'invalid' };
    const envelope = storedRead.envelope;
    if (envelope.kind === AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND) {
        return {
            kind: 'ready',
            envelope,
            payload: envelope.payload,
        };
    }
    if (!params.decryptRaw) {
        return {
            kind: 'locked',
            reason: 'encryption_material_unavailable',
        };
    }
    try {
        const payload = await params.decryptRaw(envelope.payloadCiphertext);
        if (payload === null || payload === undefined) {
            return {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            };
        }
        if (
            storedRead.legacyExistingSessionId
            && (!payload || typeof payload !== 'object' || Array.isArray(payload)
                || normalizeExistingSessionId(
                    (payload as Record<string, unknown>).existingSessionId,
                ) !== storedRead.legacyExistingSessionId)
        ) {
            return { kind: 'invalid' };
        }
        return {
            kind: 'ready',
            envelope,
            payload,
        };
    } catch {
        return {
            kind: 'locked',
            reason: 'encryption_material_unavailable',
        };
    }
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
        typeof parsed.sessionEncryptionKeyBase64 === 'string' &&
        parsed.sessionEncryptionKeyBase64.trim().length > 0;

    if (params.accountMode === 'plain' && !requiresSensitiveEncryption) {
        const envelope: PlainAutomationTemplateEnvelope = {
            kind: AUTOMATION_TEMPLATE_PLAINTEXT_ENVELOPE_KIND,
            payload: parsed,
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
