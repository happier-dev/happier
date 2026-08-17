import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { routeManifest } from '../routes';
import { entryModuleFor, entrySlugFor } from './_names';

/**
 * THE GATE ON THE ROUTE SPLIT, CHECKED WITHOUT A BUILD.
 *
 * Each prerendered page loads its own chunk, built from its own file in this
 * directory (vite.config.ts reads the directory; src/entry-server.tsx computes
 * the name each route needs). scripts/prerender.mjs fails the build when those
 * two disagree — but a build takes minutes and this takes milliseconds, and the
 * failure it catches is the easiest one to cause: adding a route, or adding a
 * locale to one, and forgetting the two-line entry that hydrates it.
 *
 * Nothing here counts routes. The site has 21 pages today and the assertions are
 * written so that number never appears.
 */

const ENTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ENTRY_DIR, '..', '..');

/** Page entries only — `_`-prefixed files are the shared halves, not pages. */
function entryFilesOnDisk(): string[] {
    return readdirSync(ENTRY_DIR)
        .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
        .sort();
}

describe('entrySlugFor', () => {
    it('names the homepage and flattens every other path', () => {
        expect(entrySlugFor('/')).toBe('home');
        expect(entrySlugFor('/security')).toBe('security');
        expect(entrySlugFor('/agents/claude-code')).toBe('agents--claude-code');
        expect(entrySlugFor('/features/usage-limits')).toBe('features--usage-limits');
    });

    it('treats a trailing slash as the same page', () => {
        // Cloudflare Pages serves /agents and /agents/ from one file, so the
        // browser can hand src/main.tsx either in dev.
        expect(entrySlugFor('/agents/')).toBe(entrySlugFor('/agents'));
    });

    it('keeps a locale-prefixed path distinct from its English original', () => {
        // routeManifest() emits one entry per (route, locale) pair, so the day a
        // route lists a second locale it asks for a second entry file. No branch
        // is needed for that here — the prefix is part of the path.
        expect(entrySlugFor('/zh-Hans/security')).toBe('zh-Hans--security');
        expect(entrySlugFor('/zh-Hans/security')).not.toBe(entrySlugFor('/security'));
    });

    it('cannot collide a two-segment path with a hyphenated one-segment path', () => {
        expect(entrySlugFor('/vs/codex-remote')).not.toBe(entrySlugFor('/vs-codex-remote'));
    });
});

describe('client entries', () => {
    it('exist for every (route, locale) pair the build emits', () => {
        const missing = routeManifest()
            .map((route) => ({ route, module: entryModuleFor(route.path) }))
            .filter(({ module }) => !existsSync(path.join(APP_ROOT, module)));

        expect(
            missing.map(({ route, module }) => `${route.path} needs ${module}`),
        ).toEqual([]);
    });

    it('are all reachable from a route — no entry ships a chunk nothing loads', () => {
        const wanted = new Set(routeManifest().map((route) => entryModuleFor(route.path)));
        const orphans = entryFilesOnDisk()
            .map((f) => `src/entries/${f}`)
            .filter((module) => !wanted.has(module));

        expect(orphans).toEqual([]);
    });

    it('map one-to-one: no two routes share an entry', () => {
        const modules = routeManifest().map((route) => entryModuleFor(route.path));
        expect(new Set(modules).size).toBe(modules.length);
    });

    it('never import the route table, which reaches every page on the site', async () => {
        // src/routes.tsx statically imports all nine page components and, through
        // them, every module in src/data — the 133 KB of copy this split exists
        // to stop shipping to everyone. One `import { … } from '../routes'` in an
        // entry silently puts the whole site back in every download, and the
        // build would still pass every other check.
        const { readFile } = await import('node:fs/promises');
        const offenders: string[] = [];
        for (const file of readdirSync(ENTRY_DIR).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))) {
            const source = await readFile(path.join(ENTRY_DIR, file), 'utf8');
            if (/from '\.\.\/routes'/.test(source)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });
});
