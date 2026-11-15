import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('publishes the build-selected guest CLI source and explicit development line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-cli-identity-'));
    try {
        for (const [source, channel] of [['home-payload', 'publicdev'], ['public-release', 'stable'], ['public-release', 'preview'], ['public-release', 'publicdev']]) {
            const outfile = join(root, `${source}-${channel}.mjs`);
            await build({
                entryPoints: [fileURLToPath(new URL('./serverRelease.ts', import.meta.url))],
                outfile, bundle: true, platform: 'node', format: 'esm',
                define: { __HAPPIER_GUEST_CLI_SOURCE__: JSON.stringify(source), __HAPPIER_GUEST_CLI_CHANNEL__: JSON.stringify(channel) },
            });
            const runtime = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
            expect(runtime.readServerGuestCliIdentity()).toEqual({ source, line: '0.3', channel });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
