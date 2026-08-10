import type { FileItem } from '@/sync/domains/input/suggestionFile';
import type { ComposerSessionSuggestionItem } from '@/sync/domains/input/suggestionSession';
import { storage } from '@/sync/domains/state/storage';

/**
 * Session catalog snapshots the composer suggestion kinds read from.
 *
 * Normalization lives here — not in the kinds — because the snapshot is an
 * external daemon payload, and parsing an external shape belongs at its
 * boundary rather than in every consumer.
 */

export type ComposerSuggestionVendorPluginItem = Readonly<{
    name: string;
    displayName?: string;
    description?: string;
    vendorPluginRef: string;
    marketplace?: string;
    source?: string;
    installed?: boolean;
    enabled?: boolean;
    backendId?: string;
    agentId?: string;
}>;

/**
 * `id`, `origin`, `backendId` and `projectionRef` are the tuple a `happier.skill` reference's
 * identity is derived from (`resolveSkillCatalogItemIdentityV1`). They are read here, at the
 * catalog boundary, because the send-time resolver derives the same identity from the same
 * catalog item: a field dropped here makes the composer write a reference the host cannot
 * resolve, or none at all.
 */
export type ComposerSuggestionSkillItem = Readonly<{
    id?: string;
    name: string;
    displayName?: string;
    description?: string;
    path?: string;
    enabled?: boolean;
    origin?: string;
    source?: string;
    projectionKind?: string;
    projectionRef?: string;
    backendId?: string;
    agentId?: string;
}>;

export type ComposerSuggestionCatalogs = Readonly<{
    files?: readonly FileItem[];
    vendorPlugins?: readonly ComposerSuggestionVendorPluginItem[];
    skills?: readonly ComposerSuggestionSkillItem[];
    /**
     * Same-server sessions (D-7). Like `files`, this is an override seam only: the session
     * source is a projection over the session-listing store, not a daemon catalog, so it is
     * never hydrated through `ensureSessionSuggestionCatalogs`.
     */
    sessions?: readonly ComposerSessionSuggestionItem[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The nested item-array aliases mirror `sessionCatalogs.ts#hasCatalogSnapshot`,
 * which accepts `vendorPlugins` / `plugins` / `items` as proof a snapshot exists.
 * Reading fewer shapes than that check accepts would make `ensure` skip the RPC
 * while the reader found nothing.
 */
function readArray(value: unknown, keys: readonly string[]): readonly unknown[] {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return [];
    for (const key of keys) {
        const child = value[key];
        if (Array.isArray(child)) return child;
    }
    return [];
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeVendorPlugin(value: unknown): ComposerSuggestionVendorPluginItem | null {
    if (!isRecord(value)) return null;
    const vendorPluginRef = readString(value.vendorPluginRef)
        ?? readString(value.mentionPath)
        ?? readString(value.path)
        ?? readString(value.ref);
    if (!vendorPluginRef) return null;
    const name = readString(value.name) ?? vendorPluginRef.replace(/^plugin:\/\//, '');
    const displayName = readString(value.displayName);
    const description = readString(value.description);
    const marketplace = readString(value.marketplace);
    const source = readString(value.source);
    const backendId = readString(value.backendId);
    const agentId = readString(value.agentId);
    return {
        name,
        vendorPluginRef,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(source ? { source } : {}),
        ...(value.installed === false ? { installed: false } : {}),
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

function normalizeSkill(value: unknown): ComposerSuggestionSkillItem | null {
    if (!isRecord(value)) return null;
    const name = readString(value.name);
    if (!name) return null;
    const id = readString(value.id);
    const displayName = readString(value.displayName);
    const description = readString(value.description);
    const path = readString(value.path);
    const origin = readString(value.origin);
    const source = readString(value.source);
    const projectionKind = readString(value.projectionKind);
    const projectionRef = readString(value.projectionRef);
    const backendId = readString(value.backendId);
    const agentId = readString(value.agentId);
    return {
        ...(id ? { id } : {}),
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(path ? { path } : {}),
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(origin ? { origin } : {}),
        ...(source ? { source } : {}),
        ...(projectionKind ? { projectionKind } : {}),
        ...(projectionRef ? { projectionRef } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

/**
 * Reads the catalog snapshots `sync/ops/sessionCatalogs.ts` writes into session
 * metadata. Those two keys are the ONLY produced ones — the former
 * `vendorPluginCatalogV1` / `vendorPlugins` / `skillCatalogV1` / `skills`
 * top-level aliases had no producer anywhere in the repository and no matching
 * presence check in `hasCatalogSnapshot`, so they were removed (SB-8).
 */
export function readComposerSuggestionCatalogs(sessionId: string): ComposerSuggestionCatalogs {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!metadata || typeof metadata !== 'object') return {};
    const record = metadata as Record<string, unknown>;
    return {
        vendorPlugins: readArray(record.sessionVendorPluginCatalogV1, ['vendorPlugins', 'plugins', 'items'])
            .map(normalizeVendorPlugin)
            .filter((item): item is ComposerSuggestionVendorPluginItem => item !== null),
        skills: readArray(record.sessionSkillCatalogV1, ['skills', 'items'])
            .map(normalizeSkill)
            .filter((item): item is ComposerSuggestionSkillItem => item !== null),
    };
}

export function matchesComposerSuggestionQuery(value: string, query: string): boolean {
    const haystack = value.trim().toLowerCase();
    const needle = query.trim().toLowerCase();
    return needle.length === 0 || haystack.includes(needle);
}
