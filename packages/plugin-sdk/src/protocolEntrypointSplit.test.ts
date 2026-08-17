import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

async function readSource(path: string): Promise<string> {
    return readFile(new URL(path, import.meta.url), 'utf8');
}

describe('SDK protocol entrypoint cut', () => {
    it('publishes disjoint protocol and contribution author surfaces and retires protocol-authoring', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

        expect(packageJson.exports['./protocol']).toEqual({
            types: './dist/protocol/index.d.ts',
            browser: './dist/protocol/index.browser.js',
            default: './dist/protocol/index.js',
        });
        expect(packageJson.exports['./contributions']).toEqual({
            types: './dist/contributions/index.d.ts',
            browser: './dist/contributions/index.browser.js',
            default: './dist/contributions/index.js',
        });
        expect(packageJson.exports['./protocol-authoring']).toBeUndefined();

        await expect(readSource('./protocol/index.ts')).resolves.toBeTruthy();
        await expect(readSource('./protocol/index.browser.ts')).resolves.toBeTruthy();
        await expect(readSource('./protocol/index.public.ts')).resolves.toBeTruthy();
        await expect(readSource('./contributions/index.ts')).resolves.toBeTruthy();
        await expect(readSource('./contributions/index.browser.ts')).resolves.toBeTruthy();
        await expect(readSource('./contributions/index.public.ts')).resolves.toBeTruthy();
        await expect(readSource('./protocol-authoring/index.ts')).rejects.toMatchObject({
            code: 'ENOENT',
        });

        const protocolSource = await readSource('./protocol/index.ts');
        const contributionsSource = await readSource('./contributions/index.ts');
        expect(protocolSource).not.toContain('defineContributionProtocol');
        expect(protocolSource).not.toContain('ContributionSurface');
        expect(contributionsSource).not.toContain('defineProtocolObject');
        expect(contributionsSource).not.toContain('ProtocolComposableSchema');
        expect(() => require.resolve('@happier-dev/plugin-sdk/protocol-authoring')).toThrow();
    });
});
