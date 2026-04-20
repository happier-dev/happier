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

type DescriptorProjectionProbeResult = Readonly<{
    generation?: number;
    descriptor?: Readonly<{
        id?: string;
        surface?: string;
        pluginId?: string;
    }>;
    resource?: Readonly<{
        id?: string;
        resourceKind?: string;
        pluginId?: string;
    }>;
}>;

describe('core e2e: plugin descriptor projection', () => {
    it('projects plugin resources and host-rendered UI descriptors through the daemon contribution registry projection', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-descriptor-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-descriptor-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-descriptor-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-descriptor-probe.mts');

        try {
            const pluginId = 'acme.descriptor.integration';
            const descriptorId = 'acme.descriptor.integration.settings';
            const resourceId = 'acme.descriptor.integration.prompt';
            await writeRuntimeProjectionPluginFixture({
                pluginRoot,
                pluginId,
                resourceId,
                settingsDescriptorId: descriptorId,
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
                    'const descriptorId = process.env.PLUGIN_DESCRIPTOR_ID;',
                    'const resourceId = process.env.PLUGIN_RESOURCE_ID;',
                    'if (!projectionHandlerUrl) throw new Error("Missing CLI_PROJECTION_HANDLER_URL");',
                    'if (!descriptorId) throw new Error("Missing PLUGIN_DESCRIPTOR_ID");',
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
                    'const descriptor = projection.uiDescriptorsById?.[descriptorId];',
                    'if (!descriptor) {',
                    '  throw new Error(`Expected projected UI descriptor ${descriptorId}`);',
                    '}',
                    'const resource = projection.resourcesById?.[resourceId];',
                    'if (!resource) {',
                    '  throw new Error(`Expected projected resource ${resourceId}`);',
                    '}',
                    'if (typeof projection.generation !== "number" || projection.generation < 0) {',
                    '  throw new Error("Expected numeric projection generation for reload freshness tracking");',
                    '}',
                    'process.stdout.write(JSON.stringify({ generation: projection.generation, descriptor, resource }));',
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
                    PLUGIN_DESCRIPTOR_ID: descriptorId,
                    PLUGIN_RESOURCE_ID: resourceId,
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                },
                encoding: 'utf8',
                timeout: 30_000,
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            const parsed = JSON.parse(spawnRes.stdout) as DescriptorProjectionProbeResult;
            expect(parsed.generation).toEqual(expect.any(Number));
            expect(parsed.descriptor).toMatchObject({
                id: descriptorId,
                surface: 'settings',
                pluginId,
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
