import { registerOverlay } from './siteData';
import { LOCALES, type Locale } from './locales';

/**
 * Every locale's translations, for the BUILD-TIME renderer only.
 *
 * The prerenderer walks all routes in all their locales in one Node process, so
 * unlike a browser it genuinely does need every overlay at once. This module is
 * imported only by src/entry-server.tsx, which is bundled separately
 * (`vite build --ssr`) and never shipped — so the eager glob that would be a
 * 553 KB regression in the client bundle costs nothing here.
 *
 * If you find yourself importing this from anything under src/entries/, stop:
 * that is the change that silently puts all nine languages back into every
 * visitor's download. A client entry imports its OWN overlay, statically, and
 * nothing else. See the note on registerOverlay in ./siteData.ts.
 */
const OVERLAYS = import.meta.glob<{ default: Record<string, string> }>('./messages/overlays/*.json', {
    eager: true,
});

export function registerAllOverlays(): void {
    for (const locale of LOCALES) {
        const mod = OVERLAYS[`./messages/overlays/${locale}.json`];
        if (mod) registerOverlay(locale as Locale, mod.default);
    }
}
