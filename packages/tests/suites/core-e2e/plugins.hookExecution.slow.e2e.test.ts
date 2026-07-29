import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import {
    createLocalExtensionPackageManifest,
    writeEnabledLocalPathPluginState,
    writeLocalPathPluginFixture,
} from '../../src/testkit/plugins/localPathPluginFixture';
import { resolveRepositoryTsxCommand } from '../../src/testkit/extensions/tsxCommand';

describe('core e2e: plugin hook execution', () => {
    it('loads and executes a supported plugin hook handler through the executable runtime registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-e2e-'));
        const hookMarkerPath = join(testDir, 'hook-fired.txt');
        const probeScriptPath = join(testDir, 'plugin-hook-probe.mts');

        try {
            const pluginId = 'acme.hook.integration';
            await writeLocalPathPluginFixture({
                pluginRoot,
                daemonModuleContents: [
                    'import { writeFile } from "node:fs/promises";',
                    '',
                    'export async function recordHookInvocation(payload = {}) {',
                    '  const markerPath = typeof payload.markerPath === "string" && payload.markerPath.length > 0 ? payload.markerPath : null;',
                    '  if (!markerPath) {',
                    '    throw new Error("Missing markerPath");',
                    '  }',
                    '',
                    '  await writeFile(markerPath, "plugin-hook-fired\\n", "utf8");',
                    '  return "plugin-hook-fired";',
                    '}',
                    '',
                ].join('\n'),
                manifest: createLocalExtensionPackageManifest({
                    pluginId,
                    displayName: 'Acme Hook Integration',
                    description: 'Exercises plugin hook execution through the executable runtime registry',
                    contributes: {
                        hooks: [
                            {
                                hookApiVersion: 1,
                                id: 'session.message.send',
                                category: 'lifecycle',
                                scope: 'session',
                                executionKind: 'observe',
                                handler: {
                                    target: 'plugin',
                                    exportName: 'recordHookInvocation',
                                },
                            },
                        ],
                    },
                }),
            });
            await writeEnabledLocalPathPluginState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const runtimeRegistryUrl = pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'resolveExecutablePluginRuntimeRegistry.ts')).href;
            const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');

            await writeFile(
                probeScriptPath,
                [
                    'const runtimeRegistryUrl = process.env.CLI_RUNTIME_REGISTRY_URL;',
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const hookMarkerPath = process.env.HOOK_MARKER_PATH;',
                    'if (!runtimeRegistryUrl) throw new Error("Missing CLI_RUNTIME_REGISTRY_URL");',
                    'if (!happyHomeDir) throw new Error("Missing HAPPIER_HOME_DIR");',
                    'if (!hookMarkerPath) throw new Error("Missing HOOK_MARKER_PATH");',
                    '',
                    'const { resolveExecutablePluginRuntimeRegistry } = await import(runtimeRegistryUrl);',
                    'const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });',
                    'const handlers = runtimeRegistry.hookHandlersByHookId.get("session.message.send");',
                    'if (!handlers || handlers.length !== 1) {',
                    '  throw new Error(`Expected one hook handler, found ${handlers?.length ?? 0}`);',
                    '}',
                    '',
                    'const result = await handlers[0].handler({ markerPath: hookMarkerPath });',
                    'if (result !== "plugin-hook-fired") {',
                    '  throw new Error(`Unexpected hook result: ${String(result)}`);',
                    '}',
                    '',
                    'process.stdout.write(String(result));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const spawnRes = spawnSync(resolveRepositoryTsxCommand(), ['--tsconfig', cliTsconfigPath, probeScriptPath], {
                cwd: join(repoRootDir(), 'apps', 'cli'),
                env: {
                    ...process.env,
                    CLI_RUNTIME_REGISTRY_URL: runtimeRegistryUrl,
                    HAPPIER_HOME_DIR: happyHomeDir,
                    HOOK_MARKER_PATH: hookMarkerPath,
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                },
                encoding: 'utf8',
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            expect(spawnRes.stdout.trim()).toBe('plugin-hook-fired');
            expect(await readFile(hookMarkerPath, 'utf8')).toBe('plugin-hook-fired\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
