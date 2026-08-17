import { resolveSkillCatalogOriginV1 } from '@happier-dev/protocol';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
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
    /**
     * Server-computed "may be mentioned". When absent the reader falls back to
     * `installed && enabled`; when present it WINS, because a daemon can enable a
     * plugin for execution while withholding it from the mention picker.
     */
    mentionable?: boolean;
    backendId?: string;
    agentId?: string;
}>;

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
    sessions?: readonly ComposerSessionSuggestionItem[];
    vendorPlugins?: readonly ComposerSuggestionVendorPluginItem[];
    skills?: readonly ComposerSuggestionSkillItem[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `catalog.items` is read first because it is the shape the protocol response
 * actually carries (`SessionSkillCatalogListResponseV1Schema` /
 * `SessionVendorPluginCatalogListResponseV1Schema` keep `catalog` alongside the
 * transformed array). The remaining nested aliases mirror
 * `sessionCatalogs.ts#hasCatalogSnapshot`, which accepts
 * `vendorPlugins` / `plugins` / `items` as proof a snapshot exists — reading
 * fewer shapes than that check accepts would make `ensure` skip the RPC while
 * the reader found nothing.
 */
function readArray(value: unknown, keys: readonly string[]): readonly unknown[] {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return [];
    const catalog = value.catalog;
    if (isRecord(catalog) && Array.isArray(catalog.items)) return catalog.items;
    for (const key of keys) {
        const child = value[key];
        if (Array.isArray(child)) return child;
    }
    return [];
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function deriveVendorPluginName(vendorPluginRef: string): string {
    const withoutScheme = vendorPluginRef.replace(/^plugin:\/\//, '');
    const markerIndex = withoutScheme.indexOf('@');
    return markerIndex > 0 ? withoutScheme.slice(0, markerIndex) : withoutScheme;
}

function normalizeVendorPlugin(value: unknown): ComposerSuggestionVendorPluginItem | null {
    if (!isRecord(value)) return null;
    const vendorPluginRef = readString(value.vendorPluginRef)
        ?? readString(value.mentionPath)
        ?? readString(value.path)
        ?? readString(value.ref);
    if (!vendorPluginRef) return null;
    const displayName = readString(value.displayName);
    const name = readString(value.name) ?? deriveVendorPluginName(vendorPluginRef);
    const description = readString(value.description);
    const marketplace = readString(value.marketplace ?? value.marketplaceId);
    const source = readString(value.source);
    const backendId = readString(value.backendId);
    const agentId = readString(value.agentId);
    const installed = readBoolean(value.installed);
    const enabled = readBoolean(value.enabled);
    const mentionable = readBoolean(value.mentionable);
    return {
        name,
        vendorPluginRef,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(source ? { source } : {}),
        ...(installed !== undefined ? { installed } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(mentionable !== undefined ? { mentionable } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

function normalizeSkill(value: unknown): ComposerSuggestionSkillItem | null {
    if (!isRecord(value)) return null;
    const id = readString(value.id);
    const name = readString(value.name);
    if (!name) return null;
    const displayName = readString(value.displayName);
    const description = readString(value.description);
    const path = readString(value.path);
    // The legacy per-backend origin fold is owned by the skill catalog schema
    // (`packages/protocol/src/runtime/catalog/skills.ts`), which produces the
    // canonical `(origin, backendId, projectionRef)` triple. The picker keeps
    // a path-aware row identity for legacy catalog ambiguity, while the
    // outbound reference separately uses the Protocol catalog identity; both
    // consume this one origin normalization owner.
    const originMetadata = resolveSkillCatalogOriginV1(
        readString(value.origin) ?? readString(value.source) ?? readString(value.projectionKind),
    );
    const source = readString(value.source);
    const projectionKind = readString(value.projectionKind);
    const projectionRef = readString(value.projectionRef) ?? originMetadata.projectionRef;
    const backendId = readString(value.backendId) ?? originMetadata.backendId;
    const agentId = readString(value.agentId);
    return {
        ...(id ? { id } : {}),
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(path ? { path } : {}),
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(originMetadata.origin ? { origin: originMetadata.origin } : {}),
        ...(source ? { source } : {}),
        ...(projectionKind ? { projectionKind } : {}),
        ...(projectionRef ? { projectionRef } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

/**
 * Reads the catalog snapshots `sync/ops/sessionCatalogs.ts` writes into session
 * metadata, through the canonical owner-view reader so a layout-1 session reads
 * its owner projection instead of the shared metadata (which may legitimately
 * carry a different, non-owner catalog).
 *
 * Those two keys are the ONLY produced ones — the former `vendorPluginCatalogV1`
 * / `vendorPlugins` / `skillCatalogV1` / `skills` top-level aliases have no
 * producer anywhere in the repository and no matching presence check in
 * `hasCatalogSnapshot`, so they were removed (SB-8).
 */
export function readComposerSuggestionCatalogs(sessionId: string): ComposerSuggestionCatalogs {
    const session = storage.getState().sessions[sessionId];
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
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

/**
 * The stable identity of a skill catalog entry, and the suggestion key derived
 * from it.
 *
 * A picker row is identified by the tuple the catalog display needs —
 * `(id, origin/source, backendId, agentId, projectionRef/projectionKind, path, name)` —
 * including `path` so legacy same-name catalog rows do not collapse. This is
 * intentionally distinct from `resolveSkillCatalogItemIdentityV1`, the
 * Protocol-owned durable reference identity that excludes machine-local paths.
 * `id` wins for the row key when the daemon supplied one, so a rename of a
 * projected skill keeps its row identity across a keystroke.
 */
export function resolveComposerSuggestionSkillIdentity(
    skill: ComposerSuggestionSkillItem,
): Readonly<{ identity: string; suggestionKey: string }> {
    const identity = [
        skill.id,
        skill.origin ?? skill.source,
        skill.backendId,
        skill.agentId,
        skill.projectionRef ?? skill.projectionKind,
        skill.path,
        skill.name,
    ]
        .map((value) => typeof value === 'string' ? value.trim() : '')
        .filter((value) => value.length > 0)
        .join(':')
        .toLowerCase();
    const suggestionKey = typeof skill.id === 'string' && skill.id.trim().length > 0
        ? skill.id.trim()
        : identity;
    return { identity, suggestionKey };
}
