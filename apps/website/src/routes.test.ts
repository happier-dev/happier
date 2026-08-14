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
        expect(manifest).toHaveLength(ROUTES.length);
        for (const entry of manifest) {
            expect(typeof entry.head).toBe('string');
            expect(entry.file.endsWith('index.html')).toBe(true);
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
