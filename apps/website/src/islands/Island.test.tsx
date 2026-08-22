import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { Island } from './Island';
import { ISLAND_ATTR, ISLAND_PROPS_ATTR } from './props';

/**
 * The whole server→browser path for an island's props, exercised against the
 * REAL renderer and the REAL comment stripper rather than against a description
 * of them.
 *
 * The two things being proved are the two that would otherwise be an argument in
 * a docblock:
 *
 *   1. React's attribute escaping survives `stripAuthoringComments()` in
 *      scripts/prerender.mjs, including for a prop that literally contains
 *      `<!--`. If it did not, the build would ship a page whose islands throw.
 *   2. The wrapper element does not disturb layout — `display: contents` is on
 *      it, so an island inside a flex or grid parent keeps its box.
 */

/** Reverses React's attribute escaping — a copy of `getAttribute()`'s behaviour. */
function unescapeAttribute(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/** Byte-for-byte the regex in scripts/prerender.mjs. */
function stripAuthoringComments(html: string): string {
    return html.replace(/<!--(?!\$|\/\$)[\s\S]*?-->/g, '');
}

const ISLAND_PROPS_RE = new RegExp(`\\s${ISLAND_ATTR}="([^"]*)"[^>]*?\\s${ISLAND_PROPS_ATTR}="([^"]*)"`, 'g');

function Widget({ code, count }: { code: string; count: number }) {
    return (
        <span>
            {code}
            {count}
        </span>
    );
}

function Bare() {
    return <span>no props</span>;
}

describe('<Island>', () => {
    it('renders the component and marks the container', () => {
        const html = renderToString(<Island name="bare" component={Bare} />);
        expect(html).toContain(`${ISLAND_ATTR}="bare"`);
        expect(html).toContain('<span>no props</span>');
    });

    it('keeps the wrapper out of layout', () => {
        // A plain <div> here would stop an island being a flex item of its
        // parent — the nav row, the badge row — and reflow it silently.
        // Matched with an optional trailing `;`: React serialises the style as
        // `display:contents`, Preact as `display:contents;`. Identical CSS, and
        // pinning one renderer's punctuation is not what this test is about.
        expect(renderToString(<Island name="bare" component={Bare} />)).toMatch(
            /style="display:contents;?"/,
        );
    });

    it('omits the props attribute for an island that takes none', () => {
        expect(renderToString(<Island name="bare" component={Bare} />)).not.toContain(ISLAND_PROPS_ATTR);
    });

    it('carries props through React escaping AND the prerenderer comment strip', () => {
        const props = { code: '</script><!-- comment --> & "quoted" \'single\' <div>&amp;</div>', count: 3 };

        const shipped = stripAuthoringComments(
            renderToString(<Island name="widget" component={Widget} props={props} />),
        );

        // The comment stripper cannot see the prop's `<!--`, because React wrote
        // it as `&lt;!--`. This assertion is the reason a data attribute was
        // chosen over an inline <script type="application/json">.
        expect(shipped).toContain('&lt;!--');

        const matches = Array.from(shipped.matchAll(ISLAND_PROPS_RE));
        expect(matches).toHaveLength(1);
        expect(matches[0][1]).toBe('widget');
        expect(JSON.parse(unescapeAttribute(matches[0][2]))).toEqual(props);
    });

    it('renders the markup from the SAME props it serialises', () => {
        // The failure this rules out is markup rendered from one set of values
        // and hydrated from another: a page that silently changes a second
        // after it loads, with no error anywhere.
        const html = renderToString(<Island name="widget" component={Widget} props={{ code: 'x', count: 7 }} />);
        const raw = Array.from(html.matchAll(ISLAND_PROPS_RE))[0][2];
        const props = JSON.parse(unescapeAttribute(raw)) as { code: string; count: number };
        expect(html).toContain(`>${props.code}</span>`.replace('</span>', ''));
        expect(html).toContain(String(props.count));
    });
});
