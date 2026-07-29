import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import {
    writeEnabledLocalExtensionPackageState,
    writeRuntimeProjectionPluginFixture,
} from '../../src/testkit/extensions/localPackageFixture';

type ContributionProjectionProbeResult = Readonly<{
    generation?: number;
    settings?: Readonly<{
        id?: string;
        pluginId?: string;
        storageScope?: string;
        fields?: readonly Readonly<{
            id?: string;
            control?: string;
        }>[];
    }>;
    resource?: Readonly<{
        id?: string;
        resourceKind?: string;
        pluginId?: string;
    }>;
}>;

describe('core e2e: plugin contribution projection', () => {
    it('projects plugin resources and canonical typed settings through the daemon contribution registry projection', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-projection-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-projection-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-projection-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-contribution-probe.mts');

        try {
            const pluginId = 'acme.projection.integration';
            const settingsId = 'preferences';
            const settingsProjectionKey = `${pluginId}/${settingsId}`;
            const resourceId = 'acme.projection.integration.prompt';
            await writeRuntimeProjectionPluginFixture({
                pluginRoot,
                pluginId,
                resourceId,
                settingsId,
            });
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const projectionHandlerUrl = pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'rpc', 'handlers', 'daemonContributionRegistryProjection.ts')).href;
            const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
            const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');

            await writeFile(
                probeScriptPath,
                [
                    'const projectionHandlerUrl = process.env.CLI_PROJECTION_HANDLER_URL;',
                    'const settingsProjectionKey = process.env.PLUGIN_SETTINGS_PROJECTION_KEY;',
                    'const resourceId = process.env.PLUGIN_RESOURCE_ID;',
                    'if (!projectionHandlerUrl) throw new Error("Missing CLI_PROJECTION_HANDLER_URL");',
                    'if (!settingsProjectionKey) throw new Error("Missing PLUGIN_SETTINGS_PROJECTION_KEY");',
                    'if (!resourceId) throw new Error("Missing PLUGIN_RESOURCE_ID");',
                    '',
                    'const { registerDaemonContributionRegistryProjectionHandler, invalidateDaemonContributionRegistryProjectionCache } = await import(projectionHandlerUrl);',
                    'invalidateDaemonContributionRegistryProjectionCache();',
                    'const handlers = new Map();',
                    'registerDaemonContributionRegistryProjectionHandler({',
                    '  registerHandler(method, handler) {',
                    '    handlers.set(method, handler);',
                    '  },',
                    '});',
                    'const handler = [...handlers.values()][0];',
                    'if (typeof handler !== "function") throw new Error("Missing daemon contribution registry projection handler");',
                    'const response = await handler({ machineId: "machine-1" });',
                    'const projection = response?.projection;',
                    'if (!projection || typeof projection !== "object") {',
                    '  throw new Error("Expected versioned daemon projection response");',
                    '}',
                    'const settings = projection.settingsById?.[settingsProjectionKey];',
                    'if (!settings) {',
                    '  throw new Error(`Expected projected settings ${settingsProjectionKey}; settings=${JSON.stringify(Object.keys(projection.settingsById ?? {}))}; resources=${JSON.stringify(Object.keys(projection.resourcesById ?? {}))}; packages=${JSON.stringify(Object.keys(projection.installedPackagesById ?? {}))}; diagnostics=${JSON.stringify(projection.diagnostics ?? [])}`);',
                    '}',
                    'const resource = projection.resourcesById?.[resourceId];',
                    'if (!resource) {',
                    '  throw new Error(`Expected projected resource ${resourceId}`);',
                    '}',
                    'if (typeof projection.generation !== "number" || projection.generation < 0) {',
                    '  throw new Error("Expected numeric projection generation for reload freshness tracking");',
                    '}',
                    'process.stdout.write(JSON.stringify({ generation: projection.generation, settings, resource }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const spawnRes = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, probeScriptPath], {
                cwd: join(repoRootDir(), 'apps', 'cli'),
                env: {
                    ...process.env,
                    HAPPIER_HOME_DIR: happyHomeDir,
                    CLI_PROJECTION_HANDLER_URL: projectionHandlerUrl,
                    PLUGIN_SETTINGS_PROJECTION_KEY: settingsProjectionKey,
                    PLUGIN_RESOURCE_ID: resourceId,
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                },
                encoding: 'utf8',
                timeout: 30_000,
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            const parsed = JSON.parse(spawnRes.stdout) as ContributionProjectionProbeResult;
            expect(parsed.generation).toEqual(expect.any(Number));
            expect(parsed.settings).toMatchObject({
                id: settingsId,
                pluginId,
                storageScope: 'local',
                fields: [
                    {
                        id: 'enabled',
                        control: 'switch',
                    },
                ],
            });
            expect(parsed.resource).toMatchObject({
                id: resourceId,
                resourceKind: 'prompt',
                pluginId,
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 30_000);
});
