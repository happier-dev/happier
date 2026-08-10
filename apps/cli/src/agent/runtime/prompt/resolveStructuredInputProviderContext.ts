import {
    HAPPIER_SKILL_MENTIONS_METADATA_KEY,
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY,
    MENTION_KIND_V1,
    SessionSkillCatalogListResponseV1Schema,
    SessionVendorPluginCatalogListResponseV1Schema,
    readMentionRefOpaqueForKindV1,
    resolveSkillCatalogItemIdentityV1,
    sanitizeMentionRefsV1,
    type MentionRefV1,
} from '@happier-dev/protocol';

/**
 * The send-time provider resolver (D-3, INV-9, R-10).
 *
 * `MentionRefV1` carries identity only, but providers need more: Codex drops any skill item
 * that lacks BOTH `name` and `path` (`backends/codex/appServer/turnInput.ts`), and OpenCode
 * uses `vendorPluginRef` verbatim as an agent name. So the provider context is reconstructed
 * here, from the live session catalogs, at dispatch — never from a snapshot frozen into the
 * reference when the composer wrote it, which is what INV-9 forbids.
 *
 * It is agent-neutral on purpose: one resolver produces the resolved envelope and every
 * adapter consumes it unchanged, so Codex and OpenCode can never drift into two policies
 * (EU-D0 §4). Provider branching stays in the provider leaves.
 */

type MetadataRecord = Record<string, unknown>;

export type StructuredInputCatalogReaders = Readonly<{
    listSkills?: () => Promise<unknown>;
    listVendorPlugins?: () => Promise<unknown>;
}>;

export type StructuredInputResolutionDiagnostic = Readonly<{
    catalog: 'skills' | 'vendorPlugins';
    reason: 'unsupported' | 'failed' | 'malformed';
    referenceCount: number;
}>;

/**
 * D-27: a known skill or vendor reference that the catalog positively does not contain
 * rejects the send rather than silently sending a message whose references vanished.
 *
 * It is deliberately NOT raised when the catalog could not be read at all — an unsupported,
 * failing or malformed catalog is a resolver failure, and D-27 forbids reporting one as
 * "reference not found". Those degrade to no provider item plus a diagnostic, which is the
 * behaviour a backend without catalog support already has.
 */
export class StructuredInputMentionResolutionError extends Error {
    readonly code = 'mention_reference_unresolved';
    readonly unresolvedRefs: readonly string[];

    constructor(unresolvedRefs: readonly string[]) {
        super(`Unresolved composer reference(s): ${unresolvedRefs.join(', ')}`);
        this.name = 'StructuredInputMentionResolutionError';
        this.unresolvedRefs = unresolvedRefs;
    }
}

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

type CatalogRead<TItem> =
    | Readonly<{ ok: true; items: readonly TItem[] }>
    | Readonly<{ ok: false; reason: StructuredInputResolutionDiagnostic['reason'] }>;

async function readCatalog<TItem>(
    read: (() => Promise<unknown>) | undefined,
    parse: (value: unknown) => Readonly<{ items: readonly TItem[]; unsupported: boolean }> | null,
): Promise<CatalogRead<TItem>> {
    if (typeof read !== 'function') return { ok: false, reason: 'unsupported' };
    let raw: unknown;
    try {
        raw = await read();
    } catch {
        return { ok: false, reason: 'failed' };
    }
    const parsed = parse(raw);
    if (!parsed) return { ok: false, reason: 'malformed' };
    if (parsed.unsupported) return { ok: false, reason: 'unsupported' };
    return { ok: true, items: parsed.items };
}

/**
 * Backends report "this catalog does not exist here" in two shapes: the RPC layer's
 * `unsupported: true` (`rpc/handlers/sessionControls.ts:577`) and the Codex app-server
 * builder's `supported: false` (`backends/codex/appServer/pluginAndSkillCatalog.ts:167`).
 * Both must read as "catalog unavailable" — reading `supported: false` as an empty catalog
 * would make every reference look positively absent and reject the send (D-27).
 */
function readCatalogUnsupported(value: Readonly<{ unsupported?: unknown; supported?: unknown }>): boolean {
    return value.unsupported === true || value.supported === false;
}

function parseSkillCatalog(value: unknown) {
    const parsed = SessionSkillCatalogListResponseV1Schema.safeParse(value);
    if (!parsed.success) return null;
    return { items: parsed.data.skills, unsupported: readCatalogUnsupported(parsed.data) };
}

function parseVendorPluginCatalog(value: unknown) {
    const parsed = SessionVendorPluginCatalogListResponseV1Schema.safeParse(value);
    if (!parsed.success) return null;
    return { items: parsed.data.vendorPlugins, unsupported: readCatalogUnsupported(parsed.data) };
}

/**
 * The legacy per-kind record the composer wrote for this catalog item. Resolution reproduces
 * it field for field: R-10's bar is behavioural identity for every consumer, and a consumer
 * reading a field the resolver dropped would diverge silently.
 */
function buildSkillMentionRecord(item: MetadataRecord): MetadataRecord {
    const name = readString(item.name);
    if (!name) return {};
    const path = readString(item.path);
    const displayName = readString(item.displayName);
    const description = readString(item.description);
    const origin = readString(item.origin) ?? readString(item.source);
    const projectionKind = readString(item.projectionKind);
    return {
        name,
        ...(path ? { path } : {}),
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(origin ? { origin } : {}),
        ...(projectionKind ? { projectionKind } : {}),
    };
}

function buildVendorPluginMentionRecord(item: MetadataRecord): MetadataRecord {
    const vendorPluginRef = readString(item.vendorPluginRef);
    if (!vendorPluginRef) return {};
    // The composer's row label, reproduced exactly: Codex displays `label ?? displayName ??
    // name ?? path`, so a resolver that skipped `label` would change the displayed name.
    const label = readString(item.displayName) ?? readString(item.name);
    const backendId = readString(item.backendId);
    const agentId = readString(item.agentId);
    return {
        vendorPluginRef,
        ...(label ? { label } : {}),
        ...(backendId ? { backendId } : {}),
        ...(agentId ? { agentId } : {}),
    };
}

/**
 * D-26: every textual occurrence stays in `mentions[]` because range reconciliation needs it,
 * but provider context is deduplicated by `{kind, ref}` and ordered by first occurrence — the
 * same order and multiplicity the legacy per-kind arrays had.
 */
function collectReferencedOpaques(
    mentions: readonly MentionRefV1[],
    kind: typeof MENTION_KIND_V1.skill | typeof MENTION_KIND_V1.vendorPlugin,
): ReadonlyArray<Readonly<{ ref: string; opaque: string }>> {
    const out: Array<Readonly<{ ref: string; opaque: string }>> = [];
    const seen = new Set<string>();
    for (const mention of mentions) {
        if (mention.kind !== kind) continue;
        if (seen.has(mention.ref)) continue;
        const opaque = readMentionRefOpaqueForKindV1(kind, mention.ref);
        if (opaque === null) continue;
        seen.add(mention.ref);
        out.push({ ref: mention.ref, opaque });
    }
    return out;
}

async function resolveSkillMentions(params: Readonly<{
    references: ReadonlyArray<Readonly<{ ref: string; opaque: string }>>;
    catalogs: StructuredInputCatalogReaders;
    unresolved: string[];
    onDiagnostic?: (diagnostic: StructuredInputResolutionDiagnostic) => void;
}>): Promise<MetadataRecord[]> {
    if (params.references.length === 0) return [];
    const catalog = await readCatalog(params.catalogs.listSkills, parseSkillCatalog);
    if (!catalog.ok) {
        params.onDiagnostic?.({ catalog: 'skills', reason: catalog.reason, referenceCount: params.references.length });
        return [];
    }

    const byIdentity = new Map<string, MetadataRecord>();
    for (const item of catalog.items) {
        const identity = resolveSkillCatalogItemIdentityV1(item);
        if (!identity) continue;
        if (!byIdentity.has(identity.id)) byIdentity.set(identity.id, item as MetadataRecord);
    }

    const resolved: MetadataRecord[] = [];
    for (const reference of params.references) {
        const item = byIdentity.get(reference.opaque);
        const record = item ? buildSkillMentionRecord(item) : {};
        if (Object.keys(record).length === 0) {
            params.unresolved.push(reference.ref);
            continue;
        }
        resolved.push(record);
    }
    return resolved;
}

async function resolveVendorPluginMentions(params: Readonly<{
    references: ReadonlyArray<Readonly<{ ref: string; opaque: string }>>;
    catalogs: StructuredInputCatalogReaders;
    unresolved: string[];
    onDiagnostic?: (diagnostic: StructuredInputResolutionDiagnostic) => void;
}>): Promise<MetadataRecord[]> {
    if (params.references.length === 0) return [];
    const catalog = await readCatalog(params.catalogs.listVendorPlugins, parseVendorPluginCatalog);
    if (!catalog.ok) {
        params.onDiagnostic?.({ catalog: 'vendorPlugins', reason: catalog.reason, referenceCount: params.references.length });
        return [];
    }

    const byRef = new Map<string, MetadataRecord>();
    for (const item of catalog.items) {
        const vendorPluginRef = readString((item as MetadataRecord).vendorPluginRef);
        if (!vendorPluginRef) continue;
        if (!byRef.has(vendorPluginRef)) byRef.set(vendorPluginRef, item as MetadataRecord);
    }

    const resolved: MetadataRecord[] = [];
    for (const reference of params.references) {
        const item = byRef.get(reference.opaque);
        const record = item ? buildVendorPluginMentionRecord(item) : {};
        if (Object.keys(record).length === 0) {
            params.unresolved.push(reference.ref);
            continue;
        }
        resolved.push(record);
    }
    return resolved;
}

/**
 * Rewrites the dispatch metadata so the provider-facing envelope is the RESOLVED model.
 *
 * `mentions[]` is removed and the per-kind arrays carry the resolved context. That is forced
 * by D-4's precedence rule, whose single owner is `readStructuredInputMentionSourcesV1`: a
 * consumer that finds `mentions` ignores the per-kind arrays entirely, so leaving `mentions`
 * in place would make the resolved arrays invisible. Removing it in the same step keeps
 * exactly one enumeration in the envelope a provider ever sees.
 *
 * The meta-root aliases are removed for the same reason: with `mentions` present the canonical
 * reader ignores them, and stripping `mentions` without stripping them would resurrect legacy
 * data that D-4 had already ruled out.
 *
 * A message with no `mentions[]` is returned byte-identical and costs zero catalog calls, so
 * the legacy path and every message without references are untouched.
 */
export async function resolveStructuredInputProviderContextInMeta(params: Readonly<{
    meta: unknown;
    catalogs?: StructuredInputCatalogReaders;
    onDiagnostic?: (diagnostic: StructuredInputResolutionDiagnostic) => void;
}>): Promise<unknown> {
    const meta = asRecord(params.meta);
    if (!meta) return params.meta;

    const envelope = asRecord(meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
    if (!envelope) return params.meta;

    const mentions = sanitizeMentionRefsV1(envelope.mentions);
    if (mentions.length === 0) return params.meta;

    const catalogs = params.catalogs ?? {};
    const unresolved: string[] = [];
    const [skillMentions, vendorPluginMentions] = await Promise.all([
        resolveSkillMentions({
            references: collectReferencedOpaques(mentions, MENTION_KIND_V1.skill),
            catalogs,
            unresolved,
            ...(params.onDiagnostic ? { onDiagnostic: params.onDiagnostic } : {}),
        }),
        resolveVendorPluginMentions({
            references: collectReferencedOpaques(mentions, MENTION_KIND_V1.vendorPlugin),
            catalogs,
            unresolved,
            ...(params.onDiagnostic ? { onDiagnostic: params.onDiagnostic } : {}),
        }),
    ]);

    if (unresolved.length > 0) throw new StructuredInputMentionResolutionError(unresolved);

    const resolvedEnvelope: MetadataRecord = { ...envelope };
    delete resolvedEnvelope.mentions;
    if (skillMentions.length > 0) {
        resolvedEnvelope.skillMentions = skillMentions;
    } else {
        delete resolvedEnvelope.skillMentions;
    }
    if (vendorPluginMentions.length > 0) {
        resolvedEnvelope.vendorPluginMentions = vendorPluginMentions;
    } else {
        delete resolvedEnvelope.vendorPluginMentions;
    }

    const resolvedMeta: MetadataRecord = { ...meta, [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: resolvedEnvelope };
    delete resolvedMeta[HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY];
    delete resolvedMeta[HAPPIER_SKILL_MENTIONS_METADATA_KEY];
    return resolvedMeta;
}
