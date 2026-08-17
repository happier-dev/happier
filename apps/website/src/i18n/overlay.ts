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
    // Responsive-image plumbing. These read as prose to a length heuristic —
    // they are long, comma-separated and full of words — and all 57 of them in
    // generatedImages.ts were being handed to a translator. A localised srcset
    // points at images that do not exist.
    'avif', 'webp', 'png', 'jpg', 'srcset', 'srcSet', 'sizes',
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
    // The first two H1 lines are a list of four product names and nothing else
    // ("Claude Code, Codex" / "OpenCode, Pi"). They read as prose to every
    // heuristic here — commas, spaces, capitals — and a translated one names
    // agents that do not exist. The ASIDE beside them ("& 9 more") is ordinary
    // copy and stays in the catalogue, which is the whole reason these two need
    // naming individually rather than the hero being excluded wholesale.
    ['pageProse.*.headlineLineOne', 'not-copy'],
    ['pageProse.*.headlineLineTwo', 'not-copy'],
    // An acronym, so the all-caps rule below reads it as a constant. Most
    // languages keep "FAQ", but that is a translator's call to make, not a
    // decision the extractor should take by never showing it to them.
    ['navigation.*.product.links.faq.label', 'copy'],
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
 * An explicit `'copy'` override beats the shape heuristic as well as the field
 * denylist. Without this the two gates disagree: the footer's "FAQ" passes
 * isCopy() because its path says so, then looksTranslatable() rejects it as an
 * all-caps constant, and the override silently does nothing. Naming a path is
 * the strongest statement available here, so it wins outright.
 */
function forcedCopy(id: string): boolean {
    return PATH_OVERRIDES.get(shape(id)) === 'copy';
}

/**
 * Names that are rendered as a bare word and must survive translation
 * byte-identical: agents, vendors, platforms, and Happier itself.
 *
 * Only single words belong here — a multi-word product name ("Claude Code",
 * "App Store") is caught by the field denylist or reaches a translator with
 * enough context to be left alone. This set exists purely to make the
 * single-capitalised-word rule below safe.
 */
const PRODUCT_NAMES: ReadonlySet<string> = new Set([
    'Happier', 'Claude', 'Codex', 'Gemini', 'OpenCode', 'Cursor', 'Copilot',
    'Qwen', 'Kimi', 'Kilo', 'Kiro', 'Auggie', 'Grok', 'Augment', 'Anthropic',
    'OpenAI', 'Google', 'GitHub', 'Discord', 'Docker', 'Tailscale', 'Homebrew',
    'Linux', 'Windows', 'Android', 'Intel', 'Apple',
]);

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
    // Shell commands, which are shown to be copy-pasted verbatim. These read as
    // prose — INSTALL_COMMAND_UNIX_INSPECTABLE even carries an English comment,
    // `# read it first` — but a localised command does not run. If that comment
    // is ever worth translating it needs its own id, not the whole invocation.
    if (/^(?:curl|iwr|wget|npm|npx|yarn|pnpm|brew|bash|sh|zsh|powershell|pwsh|docker|git|less|cat|sudo)\b/.test(t)) {
        return false;
    }
    if (/^(?:[a-z0-9:[\]/.%-]+\s+){2,}[a-z0-9:[\]/.%-]+$/.test(t) && !/[A-Z]/.test(t) && !/[.!?]/.test(t)) {
        return false;                                                    // tailwind class lists
    }
    if (/\s/.test(t) || /[.!?…]$/.test(t) || t.length > 24) return true;

    /*
     * A SINGLE CAPITALISED WORD IS COPY, UNLESS IT NAMES SOMETHING.
     *
     * This rule used to end at the line above: one word, no space, no closing
     * punctuation, under 25 characters — not prose, skip it. That was written
     * against identifiers, and it worked on identifiers. What it also silently
     * dropped was every one-word label on the site: the table headers on
     * /features/usage-limits ("Feature", "Setting", "Default", "Why"), their
     * cells ("Yes", "None", "Honoured", "Supported"), the comparison columns
     * ("Price", "Capability"), the nav ("Agents", "Enterprise", "Docs") and the
     * download badges ("Download", "Detected"). Each one rendered in English in
     * all nine languages, and because they were never extracted, nothing
     * reported them missing — a coverage report over a catalogue cannot count
     * what the catalogue does not contain.
     *
     * PRODUCT_NAMES is what keeps the rule safe. Relaxing the length test also
     * catches "Codex", "Gemini", "Happier", "Linux", "Windows" — rendered as
     * table cells and platform labels, and wrong the moment they are anything
     * else. They are excluded by name rather than by shape, because nothing
     * about their shape distinguishes them from "Default".
     */
    return /^[A-Z][a-z]{2,}(?:-[a-z]+)*$/.test(t) && !PRODUCT_NAMES.has(t);
}

export type Visit = { id: string; value: string };

/** Emit every translatable leaf string under `node`, addressed by structural id. */
export function walkStrings(node: unknown, prefix: string, out: Visit[] = []): Visit[] {
    if (typeof node === 'string') {
        if (looksTranslatable(node) || forcedCopy(prefix)) out.push({ id: prefix, value: node });
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
        if (!looksTranslatable(node) && !forcedCopy(prefix)) return node;
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
