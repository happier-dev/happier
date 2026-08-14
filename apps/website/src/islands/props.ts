/**
 * How an island's props cross from the build-time renderer to the browser.
 *
 * The prose around an island is prerendered HTML that React never owns, so there
 * is no parent component left on the client to pass props down from. The props
 * therefore have to travel inside the document, and the document is the only
 * thing both sides see.
 *
 * A DATA ATTRIBUTE, NOT AN INLINE <script type="application/json">.
 * Both are used in the wild; the attribute is the one that cannot be escaped out
 * of. A JSON blob inside a script element ends at the first `</script`
 * substring, wherever it appears — including inside a string — so every value
 * that reaches it has to be escaped by hand, and the day someone writes a page
 * about script tags the page silently breaks. An attribute has no such exit:
 * React escapes `& < > " '` on the way out (`escapeTextForBrowser`) and
 * `getAttribute()` reverses exactly that on the way in. Neither side needs to
 * know what is in the string.
 *
 * That escaping is also what protects the props from scripts/prerender.mjs's
 * `stripAuthoringComments()`, which deletes every `<!-- … -->` in the emitted
 * file. A prop containing the literal `<!--` is written as `&lt;!--`, which that
 * regex cannot see. The prerenderer asserts the round trip on every island it
 * emits rather than trusting this paragraph — see `assertIslandPropsSurvive` in
 * scripts/prerender.mjs.
 *
 * SIZE IS THE REAL COST, AND IT IS WHY MOST ISLANDS SHOULD TAKE NO PROPS.
 * Anything serialised here is in the document twice: once as the markup the
 * server already rendered from it, once as JSON. For a page of copy that is a
 * straight doubling. The rule this codebase should hold to is that an island
 * takes props only for values the island cannot import for itself — a variant
 * flag, an id, a slug — and imports its own content module otherwise. Rollup
 * ships that module to the one page that reaches it, which is the whole point of
 * the per-route split (see src/entries/_names.ts); serialising the same content
 * into an attribute pays for it twice and wins nothing.
 *
 * Note the trap that makes this rule easy to break: `useSiteData()`
 * (src/i18n/siteData.ts) imports EVERY module in src/data/. An island that calls
 * it drags the whole catalogue into that page's bundle no matter how small the
 * island is. Islands must import the one data module they need.
 */

/** The attribute that marks an element as an island container. */
export const ISLAND_ATTR = 'data-island';

/** The attribute carrying that island's serialised props. */
export const ISLAND_PROPS_ATTR = 'data-island-props';

/**
 * Props an island may take: anything `JSON.parse` can hand back.
 *
 * Deliberately not `Record<string, unknown>`. `unknown` would accept a function,
 * a Date or a ReactNode at the call site and fail only at runtime, in the
 * browser, on one page — the worst place to find out. Here the compiler refuses
 * the prop that cannot survive the trip.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type IslandProps = Readonly<Record<string, JsonValue>>;

/**
 * Props → attribute value. Runs at BUILD TIME only (src/entry-server.tsx), so it
 * can afford to be strict.
 *
 * `JSON.stringify` drops a function, a `undefined` and a symbol from an object
 * silently, which would ship an island whose prop is simply missing on the
 * client and whose failure looks like a rendering bug three components deep. The
 * replacer turns each of those into a build failure naming the prop instead.
 *
 * Returns `undefined` for an island with no props, so `<div data-island-props>`
 * is omitted entirely rather than shipping `{}` on every island on the page.
 */
export function serialiseIslandProps(name: string, props?: IslandProps): string | undefined {
    if (!props || Object.keys(props).length === 0) return undefined;

    /**
     * THE REPLACER MUST READ `this[key]`, NOT `value`.
     *
     * `JSON.stringify` applies `toJSON()` BEFORE it calls the replacer, so a
     * `Date` prop reaches the replacer already flattened to an ISO string and a
     * check for `value instanceof Date` can never fire. `this` is the holder —
     * the object (or array, or the `{ '': props }` wrapper for the root) the key
     * belongs to — so `this[key]` is the value as written at the call site,
     * before any coercion. This is the only place the raw prop is still visible.
     */
    return JSON.stringify(props, function (this: Record<string, unknown>, key: string, value: unknown) {
        const raw = this[key];
        const type = typeof raw;

        if (type === 'function' || type === 'symbol' || type === 'bigint' || type === 'undefined') {
            throw new Error(
                `island "${name}": prop "${key}" is a ${type}, which cannot cross to the browser. ` +
                    'Island props travel as JSON in a data attribute, so they must be strings, ' +
                    'numbers, booleans, null, arrays or plain objects. A callback belongs inside ' +
                    'the island; content belongs in a module the island imports.',
            );
        }

        // A Date serialises to an ISO string and parses back as a string, so the
        // island would receive a different TYPE than the server rendered with —
        // and `toJSON` makes that conversion invisible. Silent type drift across
        // the hydration boundary is worse than a build failure.
        if (raw instanceof Date) {
            throw new Error(
                `island "${name}": prop "${key}" is a Date. It would arrive in the browser as a ` +
                    'string and the island would render differently than the prerendered markup. ' +
                    'Pass the epoch milliseconds or the formatted string you actually want.',
            );
        }

        return value;
    });
}

/**
 * Attribute value → props, in the browser.
 *
 * Throws rather than falling back to `{}`. An island that mounts with no props
 * renders its default variant over markup rendered from real ones, and the only
 * symptom is a page that looks subtly wrong — the nav in the homepage's overlay
 * position on /security, say. A thrown error names the island and stops that one
 * island; the rest of the page is inert prose and stays on screen either way.
 */
export function deserialiseIslandProps(name: string, raw: string | null): IslandProps {
    if (raw === null || raw === '') return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(
            `island "${name}": ${ISLAND_PROPS_ATTR} is not valid JSON. Something between the ` +
                'renderer and the browser rewrote it — check stripAuthoringComments() in ' +
                `scripts/prerender.mjs. Received: ${raw.slice(0, 120)}`,
            { cause },
        );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(
            `island "${name}": ${ISLAND_PROPS_ATTR} parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, ` +
                'not an object of props.',
        );
    }
    return parsed as IslandProps;
}
