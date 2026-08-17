import { resolve } from 'node:path';

import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

const protocolSourceCases = [
    {
        specifier: '@happier-dev/protocol',
        source: resolve(import.meta.dirname, '../../protocol/src/index.ts'),
    },
    {
        specifier: '@happier-dev/protocol/plugins/contributions/composer-attachments',
        source: resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/contributions/composerAttachments.ts',
        ),
    },
    {
        specifier: '@happier-dev/protocol/plugins/contributions/composer-reference-candidate-id',
        source: resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/contributions/composerReferenceCandidateIdV1.ts',
        ),
    },
    {
        specifier: '@happier-dev/protocol/connect/account-usage-primitives',
        source: resolve(
            import.meta.dirname,
            '../../protocol/src/connect/providerAccountUsagePrimitives.ts',
        ),
    },
] as const;

const pluginSdkSourceCases = [
    {
        specifier: '@happier-dev/plugin-sdk',
        source: resolve(import.meta.dirname, './index.public.ts'),
    },
    {
        specifier: '@happier-dev/plugin-sdk/protocol',
        source: resolve(import.meta.dirname, './protocol/index.public.ts'),
    },
] as const;

const privateSourceSpecifiers = [
    '@happier-dev/plugin-sdk/identity',
    '@happier-dev/protocol/plugins/contributions/strictJsonValue',
] as const;

describe('Plugin SDK source Protocol resolution', () => {
    it('resolves only public SDK and Protocol exports to their canonical source owners', async () => {
        const server = await createServer({
            configFile: resolve(import.meta.dirname, '../vitest.source.config.ts'),
            logLevel: 'error',
            server: { middlewareMode: true },
        });

        try {
            for (const testCase of [...pluginSdkSourceCases, ...protocolSourceCases]) {
                const resolved = await server.pluginContainer.resolveId(
                    testCase.specifier,
                    resolve(import.meta.dirname, './composerReferenceProviders.ts'),
                );

                expect(resolved?.id).toBe(testCase.source);
                expect(resolved?.id).not.toContain('/dist/');
            }

            for (const specifier of privateSourceSpecifiers) {
                await expect(
                    server.pluginContainer.resolveId(
                        specifier,
                        resolve(import.meta.dirname, './composerReferenceProviders.ts'),
                    ),
                ).rejects.toThrow();
            }
        } finally {
            await server.close();
        }
    }, 30_000);
});
