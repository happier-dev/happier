/**
 * The one walk over a data module, used by BOTH the build-time extractor and the
 * runtime overlay.
 *
 * That sharing is the whole design. If extraction and substitution each had
 * their own traversal they would drift — a key the extractor emitted that the
 * runtime looked up under a different name is a string that silently stays
 * English forever, and nothing would fail. One function, two callers, same ids.
 *
 * WHAT COUNTS AS COPY. Everything that is a string, minus a denylist of field
 * names that are identifiers, enums, URLs or asset keys. A denylist rather than
 * a marker type on purpose: marking 1,200 strings is work, and the ambiguous
 * cases are countable — `runtime.topology` on an agent is an enum while
 * `ControlRow.topology` in terminalFeature is rendered table copy, so the
 * denylist is keyed on the PATH, not the bare field name, and both are handled
 * by one entry each.
 *
 * IDS ARE STRUCTURAL, NOT POSITIONAL where it matters. An array of objects that
 * carry a natural key (`id`, `slug`, `key`) is addressed by that key, so
 * reordering AGENTS does not renumber 227 messages and re-wording a sentence
 * does not orphan its siblings. Arrays of bare strings fall back to the index,
 * which is correct for things like `lead: [p1, p2, p3]` where position IS the
 * identity.
 */

/**
 * Field names that are never user-visible copy.
 *
 * Product and vendor names are here deliberately: they are rendered, but they
 * must survive translation byte-identical, so keeping them out of the catalogue
 * is stricter and cheaper than shipping them and hoping a do-not-translate rule
 * holds.
 */
const NOT_COPY_FIELDS: ReadonlySet<string> = new Set([
    // identity
    'id', 'slug', 'key', 'path', 'anchor', 'href', 'url', 'src',
    // product identifiers that must not be localised
    'name', 'vendor', 'binary', 'cliSubcommand', 'managedSource', 'command',
    // enums and structural flags
    'installKind', 'attachStrategy', 'availability', 'kind', 'strategy',
    'visual', 'accent', 'variant', 'tone', 'icon', 'status',
    // links and asset references
    'docsUrl', 'guideUrl', 'vendorDocs', 'happierDocsPath', 'image', 'ogImage',
    'file', 'asset', 'logo', 'mark',
    // machine-readable metadata
    'type', '@type', '@context', '@id', 'schema', 'locale', 'lang',
]);

/**
 * Exact paths that override the field-name rule, in either direction.
 * Kept small and explicit — if this grows past a screen, the rule is wrong.
 */
const PATH_OVERRIDES: ReadonlyMap<string, 'copy' | 'not-copy'> = new Map([
    // Rendered as a table cell, not an enum, despite the field name.
    ['terminalFeature.controlRows.*.topology', 'copy'],
    // An enum, despite sitting next to prose.
    ['agents.*.runtime.topology', 'not-copy'],
]);

const NATURAL_KEYS = ['id', 'slug', 'key'] as const;

function naturalKey(value: unknown): string | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    for (const k of NATURAL_KEYS) {
        const candidate = (value as Record<string, unknown>)[k];
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return null;
}

/** `agents.claude.lead.1` → `agents.*.lead.*`, for matching PATH_OVERRIDES. */
function shape(id: string): string {
    const parts = id.split('.');
    return parts.map((p, i) => (i > 0 && i < parts.length - 1 && !/^[a-z][a-zA-Z]*$/.test(p) ? '*' : p)).join('.');
}

function isCopy(id: string, field: string): boolean {
    const override = PATH_OVERRIDES.get(shape(id));
    if (override) return override === 'copy';
    return !NOT_COPY_FIELDS.has(field);
}

/**
 * A string is translatable prose only if a human would read it as language.
 * Deliberately conservative: a false negative leaves a string in English, a
 * false positive puts a CSS length or a Tailwind class list in front of a
 * translator.
 */
export function looksTranslatable(value: string): boolean {
    const t = value.trim();
    if (t.length < 2) return false;
    if (/^https?:\/\//.test(t)) return false;
    if (/^[/~.]?[\w.-]+(\/[\w.@-]+)+\/?$/.test(t)) return false;       // paths
    if (/^[a-z][a-zA-Z0-9]*$/.test(t)) return false;                    // identifiers
    if (/^[A-Z0-9_]+$/.test(t)) return false;                           // CONSTANTS
    if (/^#[0-9a-f]{3,8}$/i.test(t)) return false;                      // colours
    if (/^[\d\s.,%$+×—–-]+$/.test(t)) return false;                     // pure numbers
    if (/^(?:clamp|calc|var|rgba?|linear-gradient)\(/.test(t)) return false;
    // Keys, hashes and base64 blobs: long, no spaces, base64 alphabet only.
    // RELEASE_PUBKEY in downloads.ts reached a translator without this.
    if (!/\s/.test(t) && /^[A-Za-z0-9+/=_-]{20,}$/.test(t)) return false;
    if (/^(?:[a-z0-9:[\]/.%-]+\s+){2,}[a-z0-9:[\]/.%-]+$/.test(t) && !/[A-Z]/.test(t) && !/[.!?]/.test(t)) {
        return false;                                                    // tailwind class lists
    }
    return /\s/.test(t) || /[.!?…]$/.test(t) || t.length > 24;
}

export type Visit = { id: string; value: string };

/** Emit every translatable leaf string under `node`, addressed by structural id. */
export function walkStrings(node: unknown, prefix: string, out: Visit[] = []): Visit[] {
    if (typeof node === 'string') {
        if (looksTranslatable(node)) out.push({ id: prefix, value: node });
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((item, index) => {
            const key = naturalKey(item) ?? String(index);
            walkStrings(item, `${prefix}.${key}`, out);
        });
        return out;
    }
    if (typeof node === 'object' && node !== null) {
        for (const [field, value] of Object.entries(node as Record<string, unknown>)) {
            const id = `${prefix}.${field}`;
            if (typeof value === 'string' && !isCopy(id, field)) continue;
            if (!isCopy(id, field) && typeof value !== 'object') continue;
            walkStrings(value, id, out);
        }
    }
    return out;
}

/**
 * Return `node` with every translatable leaf replaced from `overrides`, keyed by
 * the same ids `walkStrings` produces. Missing or blank overrides keep English.
 *
 * Returns the input BY IDENTITY when nothing changed, so the English build path
 * allocates nothing and `dist/` is provably byte-identical before any locale
 * ships.
 */
export function applyOverlay<T>(node: T, overrides: Readonly<Record<string, string>>, prefix: string): T {
    if (typeof node === 'string') {
        if (!looksTranslatable(node)) return node;
        const replacement = overrides[prefix];
        return (replacement && replacement.trim() !== '' ? replacement : node) as unknown as T;
    }
    if (Array.isArray(node)) {
        let changed = false;
        const next = node.map((item, index) => {
            const key = naturalKey(item) ?? String(index);
            const mapped = applyOverlay(item, overrides, `${prefix}.${key}`);
            if (mapped !== item) changed = true;
            return mapped;
        });
        return (changed ? next : node) as unknown as T;
    }
    if (typeof node === 'object' && node !== null) {
        let changed = false;
        const next: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(node as Record<string, unknown>)) {
            const id = `${prefix}.${field}`;
            if (!isCopy(id, field) && typeof value !== 'object') {
                next[field] = value;
                continue;
            }
            const mapped = applyOverlay(value, overrides, id);
            if (mapped !== value) changed = true;
            next[field] = mapped;
        }
        return (changed ? (next as T) : node);
    }
    return node;
}
