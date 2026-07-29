import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import {
    SAMPLE_PLUGIN_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    SAMPLE_PLUGIN_PROVIDER_TITLE,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

import { handleAgentsCommand } from './agents';

describe('happier agents sample-plugin integration', () => {
    let home = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

    beforeEach(async () => {
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        home = await createTempDir('happier-agents-sample-plugin-');
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-agents-sample-plugin-root-'));
        await materializeSamplePluginFixture(pluginRoot);
        const store = createPluginStateStore({ happyHomeDir: home });
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                [SAMPLE_PLUGIN_ID]: {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        if (home) await removeTempDir(home);
    });

    it('lists the plugin-provided provider from a real local-path plugin fixture', async () => {
        const output = captureConsoleLogAndMuteStdout();
        try {
            await handleAgentsCommand(['list', '--json']);
            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('agents_list');
            expect(parsed.data.agents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: SAMPLE_PLUGIN_PROVIDER_ID,
                        title: SAMPLE_PLUGIN_PROVIDER_TITLE,
                        installed: false,
                    }),
                ]),
            );
        } finally {
            output.restore();
        }
    });

    it('shows the same plugin provider in agents status output', async () => {
        const output = captureConsoleLogAndMuteStdout();
        try {
            await handleAgentsCommand(['status', '--json']);
            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('agents_status');
            expect(parsed.data.agents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: SAMPLE_PLUGIN_PROVIDER_ID,
                        title: SAMPLE_PLUGIN_PROVIDER_TITLE,
                    }),
                ]),
            );
        } finally {
            output.restore();
        }
    });
});
