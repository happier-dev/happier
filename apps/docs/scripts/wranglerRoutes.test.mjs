import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the production Worker owns the docs.happier.dev custom domain', async () => {
    const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');

    assert.match(
        config,
        /\[\[routes\]\]\s+pattern\s*=\s*"docs\.happier\.dev"\s+custom_domain\s*=\s*true/,
    );
});
