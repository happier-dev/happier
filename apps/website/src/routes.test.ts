import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AGENTS } from './data/agents';
import { ROUTES, fileForRoute, findRoute, headTagsFor, routeManifest } from './routes';

/**
 * Route-table guards.
 *
 * scripts/assert-crawlable.mjs checks the same limits against the BUILT files,
 * which is the assertion that actually protects the deploy. These run in
 * milliseconds against the source, so the feedback arrives while the copy is
 * still being written rather than after a two-minute build.
 */

const REDIRECTS = readFileSync(path.resolve(__dirname, '../public/_redirects'), 'utf8');

describe('route table', () => {
    it('gives every route a unique path', () => {
        const paths = ROUTES.map((route) => route.path);
        expect(new Set(paths).size).toBe(paths.length);
    });

    it('gives every route a unique title that fits a SERP', () => {
        const seen = new Map<string, string>();
        for (const route of ROUTES) {
            expect(route.title.length, `${route.path}: "${route.title}"`).toBeLessThanOrEqual(60);
            expect(seen.get(route.title), `${route.path} duplicates ${seen.get(route.title)}`).toBeUndefined();
            seen.set(route.title, route.path);
        }
    });

    it('gives every route a unique description Google will not truncate', () => {
        const seen = new Map<string, string>();
        for (const route of ROUTES) {
            expect(route.description.length, `${route.path}`).toBeLessThanOrEqual(155);
            expect(route.description.length, `${route.path} description is a stub`).toBeGreaterThan(60);
            expect(seen.get(route.description), `${route.path} duplicates ${seen.get(route.description)}`).toBeUndefined();
            seen.set(route.description, route.path);
        }
    });

    /**
     * The route-level checks above see ONE title per route. This one sees every
     * FILE the build emits, which is where a locale goes wrong: a route that
     * declares `locales: ['en', 'zh-Hans']` without a matching `i18n['zh-Hans']`
     * entry writes the English title into /zh/ too, and then two URLs compete
     * for the same query — the exact failure the route-level guard was written
     * to prevent, reintroduced one dimension over.
     *
     * Titles and descriptions cannot be translated into the caps anyway (the
     * English is authored at 143-155 against a 155 ceiling), so being forced to
     * author them per locale is the correct outcome, not an inconvenience.
     */
    it('gives every emitted page — each locale of each route — its own title and description', () => {
        const titles = new Map<string, string>();
        const descriptions = new Map<string, string>();

        for (const entry of routeManifest()) {
            expect(entry.title.length, `${entry.path}: "${entry.title}"`).toBeLessThanOrEqual(60);
            expect(entry.description.length, `${entry.path}`).toBeLessThanOrEqual(155);
            expect(
                titles.get(entry.title),
                `${entry.path} ships the same <title> as ${titles.get(entry.title)}. ` +
                    `Give it \`i18n['${entry.locale}'].title\` in src/routes.tsx, or drop ` +
                    `'${entry.locale}' from that route's \`locales\`.`,
            ).toBeUndefined();
            expect(
                descriptions.get(entry.description),
                `${entry.path} ships the same description as ${descriptions.get(entry.description)}. ` +
                    `Give it \`i18n['${entry.locale}'].description\`, or drop '${entry.locale}'.`,
            ).toBeUndefined();
            titles.set(entry.title, entry.path);
            descriptions.set(entry.description, entry.path);
        }
    });

    it('mints a unique page-scoped JSON-LD @id for every route', () => {
        const seen = new Map<string, string>();
        for (const route of ROUTES) {
            for (const node of route.jsonLd) {
                const id = node['@id'];
                expect(typeof id, `${route.path} has a JSON-LD node with no @id`).toBe('string');
                expect(
                    seen.get(id as string),
                    `${route.path} and ${seen.get(id as string)} both declare @id "${id}"`,
                ).toBeUndefined();
                seen.set(id as string, route.path);
            }
        }
    });

    it('gives every agent exactly one page', () => {
        for (const agent of AGENTS) {
            expect(findRoute(`/agents/${agent.slug}`), `no route for ${agent.slug}`).toBeDefined();
        }
        const agentRoutes = ROUTES.filter((route) => route.path.startsWith('/agents/'));
        expect(agentRoutes).toHaveLength(AGENTS.length);
    });

    it('resolves a trailing slash to the same route', () => {
        expect(findRoute('/agents/')?.path).toBe('/agents');
        expect(findRoute('/')?.path).toBe('/');
        expect(findRoute('/nope')).toBeUndefined();
    });

    it('writes each route to its own real file, never a rewrite', () => {
        expect(fileForRoute('/')).toBe('index.html');
        expect(fileForRoute('/agents')).toBe('agents/index.html');
        expect(fileForRoute('/vs/claude-code-remote-control')).toBe(
            'vs/claude-code-remote-control/index.html',
        );
    });

    it('emits a self-referencing canonical in every head', () => {
        for (const route of ROUTES) {
            const head = headTagsFor(route);
            expect(head).toContain(`<link rel="canonical" href="https://happier.dev${route.path}" />`);
            expect(head).toContain('property="og:url"');
            expect(head).toContain('application/ld+json');
        }
    });

    it('escapes `<` inside JSON-LD so a script tag cannot be closed early', () => {
        const head = headTagsFor(ROUTES[0]!);
        const blocks = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
            const body = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
            expect(body).not.toMatch(/</);
        }
    });

    it('produces a manifest the build scripts can consume without React', () => {
        const manifest = routeManifest();
        // One entry per (route, locale) pair, not per route. While every route
        // is English-only these are the same number, which is the property that
        // let the locale dimension land without changing a single output file.
        const expected = ROUTES.reduce((n, route) => n + (route.locales?.length ?? 1), 0);
        expect(manifest).toHaveLength(expected);
        for (const entry of manifest) {
            expect(typeof entry.head).toBe('string');
            expect(entry.file.endsWith('index.html')).toBe(true);
            expect(entry.htmlLang.length, `${entry.path} has no html lang`).toBeGreaterThan(0);
        }
    });

    // public/_redirects is the file most likely to be edited without anyone
    // re-reading the route table, and a rule pointing at a route that no longer
    // exists is a 301 into a 404 — strictly worse than no rule.
    it('only aliases URLs that are real routes', () => {
        for (const line of REDIRECTS.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const [, destination] = trimmed.split(/\s+/);
            if (!destination?.startsWith('/')) continue;
            expect(findRoute(destination), `_redirects sends ${trimmed} to a non-route`).toBeDefined();
        }
    });

    it('never adds the SPA catch-all', () => {
        expect(REDIRECTS).not.toMatch(/^\s*\/\*\s+\/index\.html\s+200/m);
    });
});
