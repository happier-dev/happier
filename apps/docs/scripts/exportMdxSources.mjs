#!/usr/bin/env node
/**
 * Moves the exported Markdown sources to the URLs they are actually served at.
 *
 * WHY THIS EXISTS. `<page>.mdx` returns that page's Markdown source, which is
 * what an agent told to "read the docs" should fetch instead of scraping HTML.
 * It used to be a Next `rewrites()` rule, and after the static-export migration
 * it was a Cloudflare Worker rewrite — which meant EVERY `.mdx` request woke the
 * Worker and counted as a billable invocation, purely to map one path onto
 * another.
 *
 * Moving the files removes the indirection entirely: `/agents.mdx` becomes a
 * real static asset, served by the asset layer for free and without invoking
 * anything. `run_worker_first` in wrangler.toml lost `/*.mdx` at the same time
 * this was added — the two changes are one change, and reverting either alone
 * breaks the route.
 *
 * WHY MOVE AND NOT COPY. A copy leaves the same bytes at two public URLs, which
 * is a duplicate for anything that crawls and a second thing to keep in sync.
 * Nothing references `/llms.mdx/docs/*` — it was only ever the rewrite target —
 * so nothing loses an address it was using.
 *
 * WHY THE NAMES CANNOT COLLIDE. `out/agents.mdx` sits beside `out/agents.html`
 * and `out/agents/`, all three distinct: the extension is what keeps the file
 * namespace clear of the directory namespace. That is the same reason the route
 * emits the extension in the first place (see its own note).
 */

import { readdir, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultOutDir = path.resolve(here, '..', 'out');

/** The export's staging location — the route's own path, not a public one. */
const STAGING = path.join('llms.mdx', 'docs');

async function walk(dir) {
    const found = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await walk(full)));
        else if (entry.name.endsWith('.mdx')) found.push(full);
    }
    return found;
}

export async function relocateMdxSources({ outDir = defaultOutDir } = {}) {
    const staging = path.join(outDir, STAGING);
    const sources = await walk(staging);

    // Zero is a real failure, not a no-op: the route is supposed to emit one
    // file per page, so an empty staging directory means the export changed
    // shape and every `.mdx` URL is about to 404 silently.
    if (sources.length === 0) {
        throw new Error(
            `exportMdxSources: no .mdx files under out/${STAGING}. The route that ` +
                'emits them (src/app/llms.mdx/docs/[...slug]/route.ts) did not run, or ' +
                'changed shape — publishing now would 404 every <page>.mdx URL.',
        );
    }

    for (const source of sources) {
        const target = path.join(outDir, path.relative(staging, source));
        await mkdir(path.dirname(target), { recursive: true });
        await rename(source, target);
    }

    // The staging tree is an implementation detail of the export. Leaving it
    // behind would publish every source twice, at two different URLs.
    await rm(path.join(outDir, 'llms.mdx'), { recursive: true, force: true });

    return sources.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const moved = await relocateMdxSources();
    console.log(`exportMdxSources: moved ${moved} Markdown sources to their public paths`);
}
