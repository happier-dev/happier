import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from './index';
import { AgentsIndex } from '../pages/AgentsIndex';
import { UPCOMING_LABEL } from '../data/availability';

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
    const chinese = '将在 v0.3 中推出';

    it('renders the English label under the default locale', () => {
        const markup = renderToStaticMarkup(
            <LocaleProvider locale="en">
                <AgentsIndex />
            </LocaleProvider>,
        );
        expect(markup).toContain(UPCOMING_LABEL);
        expect(markup).not.toContain(chinese);
    });

    it('renders the overlay translation under zh-Hans', () => {
        const markup = renderToStaticMarkup(
            <LocaleProvider locale="zh-Hans">
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

    it('falls back to English for every string the overlay does not cover', () => {
        // The overlay carries one id. Everything else on the page must still
        // render, in English, rather than blanking — that is the whole point of
        // the per-key fallback.
        const markup = renderToStaticMarkup(
            <LocaleProvider locale="zh-Hans">
                <AgentsIndex />
            </LocaleProvider>,
        );
        expect(markup).toContain('Claude Code');
        expect(markup.length).toBeGreaterThan(5000);
    });
});
