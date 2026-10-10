import {
    PredecessorVoiceCredentialBindingV1Schema,
    type PredecessorVoiceCredentialBindingV1,
} from '../realtime/providerSettings.js';

export { PredecessorVoiceCredentialBindingV1Schema };
export type { PredecessorVoiceCredentialBindingV1 };

export function parsePredecessorVoiceCredentialBindings(
    value: unknown,
): readonly PredecessorVoiceCredentialBindingV1[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = value as Readonly<Record<string, unknown>>;
    if (!Array.isArray(raw.credentialBindings)) return [];
    return raw.credentialBindings.slice(0, 64).flatMap((candidate) => {
        const parsed = PredecessorVoiceCredentialBindingV1Schema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}
