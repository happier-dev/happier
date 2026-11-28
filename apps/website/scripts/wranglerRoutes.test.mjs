import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the production Worker owns the happier.dev custom domain', async () => {
    const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');

    assert.match(
        config,
        /\[\[routes\]\]\s+pattern\s*=\s*"happier\.dev"\s+custom_domain\s*=\s*true/,
    );
});

test('next owns only the prerelease site and catalog, leaving the stable domain separate', async () => {
    const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const [production, next] = config.split('[env.next]');
    assert.doesNotMatch(production, /pattern\s*=\s*"marketplace\.happier\.dev\/catalog\.json"/);
    assert.ok(next, 'next must be a separate Worker environment');
    assert.match(next, /name\s*=\s*"happier-website-next"/);
    assert.match(next, /workers_dev\s*=\s*false/);
    const routes = [...next.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(routes, ['next.happier.dev', 'marketplace.happier.dev/catalog.json']);
    assert.match(next, /\[\[env\.next\.routes\]\]\s+pattern\s*=\s*"next\.happier\.dev"\s+custom_domain\s*=\s*true/);
    assert.match(next, /pattern\s*=\s*"marketplace\.happier\.dev\/catalog\.json"\s+zone_name\s*=\s*"happier\.dev"/);
});
