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
    {
        specifier: '@happier-dev/protocol/strings/opaqueIdentifier',
        source: resolve(
            import.meta.dirname,
            '../../protocol/src/strings/opaqueIdentifier.ts',
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
    it.each(['vitest.config.ts', 'vitest.source.config.ts'])('resolves public workspace exports to their canonical source owners with %s', async (config) => {
        const server = await createServer({
            configFile: resolve(import.meta.dirname, '..', config),
            logLevel: 'error',
            optimizeDeps: { noDiscovery: true, include: [] },
            server: { middlewareMode: true, hmr: false, watch: null },
        });

        try {
            for (const testCase of [
                ...pluginSdkSourceCases,
                ...protocolSourceCases,
                {
                    specifier: '@happier-dev/release-runtime/releaseRings',
                    source: resolve(import.meta.dirname, '../../release-runtime/src/releaseRings.ts'),
                },
                {
                    specifier: '@happier-dev/email-transports-protocol/v1',
                    source: resolve(import.meta.dirname, '../../email-transports-protocol/src/v1/index.ts'),
                },
                {
                    specifier: '@happier-dev/forge-ci/runtime',
                    source: resolve(import.meta.dirname, '../../forge-ci/src/runtime.ts'),
                },
                {
                    specifier: '@happier-dev/plugin-ui/ansi',
                    source: resolve(import.meta.dirname, '../../plugin-ui/src/ansi.ts'),
                },
            ]) {
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
