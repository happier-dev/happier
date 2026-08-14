import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from './index';
import { AgentsIndex } from '../pages/AgentsIndex';
import { UPCOMING_LABEL } from '../data/availability';
import { registerOverlay, siteDataFor } from './siteData';
import zhHansOverlay from './messages/overlays/zh-Hans.json';

// Registering the overlay explicitly is the whole point, not test scaffolding.
// siteData used to discover locales with an eager `import.meta.glob`, which put
// all nine languages — 1.4 MB — into the chunk every route shares. A client
// entry now imports exactly its own overlay and hands it over, and this is that
// same path: if registration stops working, these tests go red rather than the
// site quietly shipping English.
registerOverlay('zh-Hans', zhHansOverlay as Record<string, string>);

/**
 * The end-to-end proof, and the reason it is a RENDER test rather than a unit
 * test of the overlay.
 *
 * Every earlier link in this chain can be green while the page still ships
 * English: the catalogue can be complete, `applyOverlay` can substitute
 * correctly, and the string still never reaches the reader because a component
 * imported the data module directly instead of calling useSiteData(). That is
 * exactly the state the previous attempt at this died in — everything written,
 * nothing mounted — and nothing failed to say so.
 *
 * So this renders a real page through a real LocaleProvider and asserts the
 * translated string is in the HTML. It is the only assertion in the suite that
 * would catch a component that was missed by the import codemod.
 */
describe('a translated string reaches rendered HTML', () => {
    // READ FROM THE OVERLAY, NOT PINNED AS LITERALS. These used to be two
    // hard-coded Chinese sentences, and they broke the moment the translation
    // was revised — which is a test failing for a reason that is not a defect.
    // What is being proved is that the overlay REACHES the page; the wording is
    // the translator's business and changes without the mechanism changing.
    const overlay = zhHansOverlay as Record<string, string>;
    const chinese = overlay['availability.UPCOMING_LABEL'];
    const chinesePageProse = overlay['pageProse.PAGE_PROSE.agentsIndex.p0'];

    it('renders the English label under the default locale', () => {
        const markup = renderToStaticMarkup(
            <LocaleProvider locale="en" path="/agents">
                <AgentsIndex />
            </LocaleProvider>,
        );
        expect(markup).toContain(UPCOMING_LABEL);
        expect(markup).not.toContain(chinese);
    });

    it('renders the overlay translation under zh-Hans', () => {
        const markup = renderToStaticMarkup(
            <LocaleProvider locale="zh-Hans" path="/zh/agents">
                <AgentsIndex />
            </LocaleProvider>,
        );
        expect(
            markup,
            'the zh-Hans overlay did not reach the page — AgentsIndex is probably still ' +
                'importing the data module directly instead of calling useSiteData()',
        ).toContain(chinese);
        expect(markup).not.toContain(UPCOMING_LABEL);
    });

    it('renders lifted page prose through the locale overlay instead of its static source import', () => {
        expect(chinesePageProse, 'the overlay has no entry for this id any more').toBeTypeOf('string');
        expect(siteDataFor('zh-Hans').pageProse.PAGE_PROSE.agentsIndex.p0).toBe(chinesePageProse);

        const markup = renderToStaticMarkup(
            <LocaleProvider locale="zh-Hans" path="/zh/agents">
                <AgentsIndex />
            </LocaleProvider>,
        );
        expect(markup).toContain(chinesePageProse);
    });

    it('falls back to English for every string the overlay does not cover', () => {
        // The overlay carries one id. Everything else on the page must still
        // render, in English, rather than blanking — that is the whole point of
        // the per-key fallback.
        const markup = renderToStaticMarkup(
            <LocaleProvider locale="zh-Hans" path="/zh/agents">
                <AgentsIndex />
            </LocaleProvider>,
        );
        expect(markup).toContain('Claude Code');
        expect(markup.length).toBeGreaterThan(5000);
    });
});
