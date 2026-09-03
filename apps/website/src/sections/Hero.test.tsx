import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '../i18n';
import { DownloadStats } from '../components/DownloadStats';
import { ISLANDS } from '../entries/_islands';
import { ISLAND_ATTR } from '../islands/props';
import { Hero } from './Hero';

describe('<Hero>', () => {
    it('hydrates the download counter so it can replace the prerendered fallback', () => {
        const html = renderToString(
            <LocaleProvider locale="en" path="/">
                <Hero />
            </LocaleProvider>,
        );

        expect(html).toContain(`${ISLAND_ATTR}="download-stats"`);
        expect(ISLANDS['download-stats']).toBe(DownloadStats);
    });
});
