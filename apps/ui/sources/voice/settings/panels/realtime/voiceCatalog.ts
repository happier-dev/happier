import type { BundledConversationProviderClient } from '@/voice/credentials/bundledConversationClient';
import { readSessionVoiceSettingFieldV1, type SessionVoiceDeclarationV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { tLoose } from '@/text';
import { z } from 'zod/mini';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

export const VoiceCatalogRowsSchema = z.array(z.strictObject({
    id: z.string().check(z.minLength(1)), name: z.string(), subtitle: z.optional(z.string()),
    previewUrl: z.optional(z.nullable(z.string())),
    previewAvailable: z.optional(z.boolean()),
}));
export type VoiceCatalogRow = Readonly<z.infer<typeof VoiceCatalogRowsSchema>[number]>;
export type VoiceCatalogClient = Pick<BundledConversationProviderClient, 'fetchVoiceCatalog'>;
export function readVoiceCatalogSettingsActionResult(result: ActionExecuteResult): readonly VoiceCatalogRow[] {
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
    const receipt = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(result.result);
    const value = record(receipt.value);
    if (receipt.status !== 'completed' || !value) {
        const code = receipt.reason ?? 'voice_catalog_unavailable';
        throw Object.assign(new Error(code), { code });
    }
    return VoiceCatalogRowsSchema.parse(value.rows);
}
/** Catalog inspection exposes preview capability, while playback keeps provider URLs private. */
export function projectVoiceSettingsCatalogList(rows: readonly VoiceCatalogRow[], canSynthesize = false) {
    return rows.map(row => ({ id: row.id, name: row.name, ...(row.subtitle ? { subtitle: row.subtitle } : {}),
        previewAvailable: canSynthesize || Boolean(row.previewUrl) }));
}
function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Static voice names come from the provider declaration, through the same catalog owner as fetched rows. */
export function readDeclaredVoiceSettingsCatalog(declaration: SessionVoiceDeclarationV1): readonly VoiceCatalogRow[] | null {
    const voiceField = readSessionVoiceSettingFieldV1(declaration);
    const field = declaration.settings?.presentation?.fields.find(candidate => candidate.path === voiceField?.path);
    if (!field?.options) return null;
    return field.options.map(option => {
        if (typeof option === 'string') return { id: option, name: option };
        const title = option.titleKey ?? option.title;
        const name = typeof title === 'string' ? tLoose(title) : title?.fallback ?? option.id;
        return { id: option.id, name };
    });
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
