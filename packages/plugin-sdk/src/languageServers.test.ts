import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    derivePluginDaemonContributionRegistrationRights,
    PluginManifestV2Schema,
} from '@happier-dev/protocol';

import type { PluginLanguageServerContributionV1 } from './index.public.js';
import { parsePluginManifest } from './manifest.js';
import { createPluginRegistrationScope } from './registration/scope.js';

const server = {
    id: 'example',
    title: 'Example language server',
    languageIds: { example: 'example-language', exampleTemplate: 'example-template' },
    filePatterns: ['*.example'],
    rootMarkers: ['example.config.json'],
    executable: { kind: 'systemTool', id: 'example-tool' },
    args: ['--stdio'],
    projectCheck: { executable: { kind: 'systemTool', id: 'example-tool' }, args: ['--check'],
        projectFile: ' config.json ', output: { kind: 'typescript' } },
    initializationOptions: { indexing: { enabled: false } },
    settings: { example: { diagnostics: true } },
} as const satisfies PluginLanguageServerContributionV1;

function declareServer(extra: Readonly<Record<string, unknown>> = {}) {
    const { id: _id, ...declaration } = server;
    return definePlugin({
        id: 'com.example.language-server',
        version: '1.0.0',
        systemTools: {
            'example-tool': { title: 'Example tool', executableNames: ['example-language-server'] },
        },
        languageServers: { example: { ...declaration, ...extra } },
    });
}

describe('language server author declarations', () => {
    it('preserves a public author declaration through strict Protocol admission without runtime registration', async () => {
        const plugin = declareServer();
        const manifest = PluginManifestV2Schema.parse(plugin.manifest);
        expect(manifest.contributes.languageServers).toEqual([server]);
        const parsed = parsePluginManifest(plugin.manifest);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.manifest.contributes.languageServers).toEqual([server]);

        const rights = derivePluginDaemonContributionRegistrationRights(manifest);
        expect(rights).toEqual([]);
        const scope = createPluginRegistrationScope({
            pluginId: manifest.id,
            target: { realm: 'daemon' },
            rights,
        });
        await plugin.activate(scope.api);
        expect(scope.api).not.toHaveProperty('languageServers');
        expect(scope.commit()).toEqual([]);
    });

    it.each([
        { command: 'example-language-server' },
        { projectLocalExecutable: './node_modules/.bin/example' },
        { env: { EXAMPLE: '1' } },
        { timeouts: { initializeMs: 1_000 } },
        { resolve: () => server },
    ])('refuses undeclared launch or resolver fields during strict admission: %j', (extra) => {
        const plugin = declareServer(extra);
        expect(PluginManifestV2Schema.safeParse(plugin.manifest).success).toBe(false);
        expect(parsePluginManifest(plugin.manifest).ok).toBe(false);
    });
});
