import { validateServerConfigText } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type { ServerConfigEntryInput } from '@happier-dev/protocol/serverConfig/serverConfigEntry';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

/**
 * Registry facts for keys the Home derives from its own owners (feature limits, retention domains).
 * Clients know those keys only through the `declaration` `home.settings.get` projects, so the
 * registry's own codec is fed from it here instead of from the static `SERVER_CONFIG`: one parser,
 * the one the Home validates writes with.
 */
export function homeSettingRegistryEntry(entry: HomeSettingEntryV1): ServerConfigEntryInput | null {
    const declaration = entry.declaration;
    if (!declaration) return null;
    return {
        type: declaration.type,
        bounds: declaration.bounds,
        sensitivity: entry.secretSet === undefined ? 'plain' : 'secret',
        apply: entry.apply,
        editable: entry.editable,
        section: declaration.section,
        description: '',
    };
}

export type HomeSettingTextParse =
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; reason: 'required' | 'invalid' }>;

/** Parses what an owner typed for a declared key; an empty field is `required`. */
export function parseHomeSettingText(entry: HomeSettingEntryV1, text: string): HomeSettingTextParse {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: 'required' };
    const registryEntry = homeSettingRegistryEntry(entry);
    if (!registryEntry) return { ok: false, reason: 'invalid' };
    const parsed = validateServerConfigText(registryEntry, trimmed);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: 'invalid' };
}

/** Only a Home-editable key the deployment has not fixed may be written from the console. */
export function isHomeSettingWritable(entry: HomeSettingEntryV1 | undefined): entry is HomeSettingEntryV1 {
    return entry !== undefined && !entry.fixed && entry.editable === 'home';
}
