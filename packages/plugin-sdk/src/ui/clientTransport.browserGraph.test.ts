import { resolve } from 'node:path';

import { build, normalizePath } from 'vite';
import { describe, expect, it } from 'vitest';

const hostedWebGuestClientEntry = normalizePath(resolve(import.meta.dirname, './client.ts'));
const protocolUiClientEntry = normalizePath(resolve(
    import.meta.dirname,
    '../../../protocol/src/plugins/ui/client.ts',
));
const protocolUiEntry = normalizePath(resolve(
    import.meta.dirname,
    '../../../protocol/src/plugins/ui/index.ts',
));

async function bundleHostedWebGuestClient(): Promise<Readonly<{
    moduleIds: readonly string[];
    code: string;
}>> {
    const moduleIds = new Set<string>();
    const virtualEntry = 'virtual:hosted-web-guest-client';
    const resolvedVirtualEntry = `\0${virtualEntry}`;
    const result = await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: [
                {
                    find: '@happier-dev/protocol/plugins/ui/client',
                    replacement: protocolUiClientEntry,
                },
                {
                    find: '@happier-dev/protocol/plugins/ui',
                    replacement: protocolUiEntry,
                },
            ],
        },
        plugins: [{
            name: 'hosted-web-guest-client-browser-entry',
            resolveId(id) {
                return id === virtualEntry ? resolvedVirtualEntry : null;
            },
            load(id) {
                if (id !== resolvedVirtualEntry) return null;
                return [
                    `export { createPluginUiHostApiClient, createPluginUiRenderContext } from ${JSON.stringify(hostedWebGuestClientEntry)};`,
                ].join('\n');
            },
            generateBundle() {
                for (const id of this.getModuleIds()) moduleIds.add(id);
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                input: virtualEntry,
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    inlineDynamicImports: true,
                },
            },
        },
    });
    const outputs = (Array.isArray(result) ? result : [result])
        .flatMap((item) => ('output' in item ? item.output : []));
    const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') {
        throw new Error('Vite did not emit the hosted-web guest client entry');
    }
    return { moduleIds: [...moduleIds], code: entry.code };
}

describe('hosted-web guest client browser graph', () => {
    it('keeps Host API semver admission in the host, not every guest bundle', async () => {
        const { moduleIds, code } = await bundleHostedWebGuestClient();

        expect(moduleIds).toContain(hostedWebGuestClientEntry);
        expect(moduleIds).toContain(protocolUiClientEntry);
        expect(moduleIds.filter((id) => id.includes('/semver/'))).toEqual([]);
        expect(code).not.toMatch(/(?:from\s*|import\s*\(|require\()\s*['"]semver['"]/u);
    }, 60_000);
});
