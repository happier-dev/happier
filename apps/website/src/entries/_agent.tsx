import { AGENTS_BY_SLUG } from '../data/agents';
import type { Locale } from '../i18n/locales';
import { mount } from './_mount';

/**
 * The thirteen /agents/<slug> entries, minus the slug.
 *
 * Deliberately NOT in _mount.tsx. This module pulls in AgentDetail and
 * src/data/agents.ts; _mount.tsx is imported by every entry on the site, so
 * putting these two imports there would hand the 93 KB agent catalogue and the
 * detail page to a visitor reading /security. Here it is reachable from thirteen
 * entries and no others, so Rollup emits it as a chunk those thirteen share.
 *
 * The record is looked up by slug rather than passed in, because the lookup is
 * the only thing an entry would otherwise have to get right. src/routes.tsx
 * builds its thirteen routes from the same `AGENTS` array, so this is the same
 * object the build-time renderer used — which is what hydration compares.
 */
export function mountAgentPage(locale: Locale, slug: string): void {
    const agent = AGENTS_BY_SLUG.get(slug);
    if (!agent) {
        throw new Error(
            `src/entries/agents--${slug}.tsx names an agent that is not in AGENTS ` +
                '(src/data/agents.ts). Rename the entry file to the agent’s slug, or ' +
                'delete it — the route it hydrates does not exist.',
        );
    }
    // `agent` above is looked up only to FAIL FAST on a slug that names nothing.
    // The page itself is never imported here any more: it is prose, it is
    // already in the prerendered HTML, and mount() only wires up the islands.
    void agent;
    mount(locale);
}
