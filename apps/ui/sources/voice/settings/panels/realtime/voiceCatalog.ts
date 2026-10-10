import type { BundledConversationProviderClient } from '@/voice/credentials/bundledConversationClient';

export type VoiceCatalogRow = Readonly<{ id: string; name: string; subtitle?: string; previewUrl?: string | null }>;
export type VoiceCatalogClient = Pick<BundledConversationProviderClient, 'fetchVoiceCatalog'>;
function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Settings UI and Actions resolve preview IDs from the same provider catalog, never caller URLs. */
export async function fetchVoiceSettingsCatalog(client: VoiceCatalogClient, signal?: AbortSignal | null): Promise<readonly VoiceCatalogRow[]> {
    return (await client.fetchVoiceCatalog(signal)).flatMap(raw => {
        const value = record(raw);
        if (!value) return [];
        const id = typeof value.id === 'string' ? value.id : typeof value.voiceId === 'string' ? value.voiceId : null;
        if (!id || typeof value.name !== 'string') return [];
        const metadata = record(value.metadata);
        const labels = record(value.labels);
        const subtitle = typeof value.category === 'string' ? value.category : typeof metadata?.description === 'string' ? metadata.description : typeof labels?.accent === 'string' ? labels.accent : undefined;
        const previewUrl = typeof value.previewUrl === 'string' ? value.previewUrl : typeof metadata?.previewUrl === 'string' ? metadata.previewUrl : null;
        return [{ id, name: value.name, ...(subtitle ? { subtitle } : {}), previewUrl }];
    });
}
