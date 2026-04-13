import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import { resolveTsxImportHookPath } from '../../src/testkit/process/tsxImportHook';

async function writePluginFixture(params: Readonly<{
    pluginRoot: string;
}>): Promise<void> {
    const manifestDir = join(params.pluginRoot, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });

    await writeFile(
        join(params.pluginRoot, 'daemon.mjs'),
        [
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
        'utf8',
    );

    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                id: 'acme.hook.integration',
                version: '1.0.0',
                displayName: 'Acme Hook Integration',
                description: 'Exercises plugin hook execution through the executable runtime registry',
                engines: {
                    happier: '^0.2.0',
                },
                targets: {
                    daemon: {
                        entry: './daemon.mjs',
                    },
                },
                contributions: {
                    hooks: [
                        {
                            hookApiVersion: 1,
                            id: 'backend.terminalRuntime.bindTranscript',
                            category: 'integration',
                            scope: 'backend',
                            executionKind: 'integrate',
                            handler: {
                                target: 'plugin',
                                exportName: 'recordHookInvocation',
                            },
                        },
                    ],
                },
            },
            null,
            2,
        ),
        'utf8',
    );
}

async function writeEnabledLocalPathPluginState(params: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    pluginId: string;
}>): Promise<void> {
    const stateDir = join(params.happyHomeDir, 'extensions', 'plugins', 'state');
    const installedDir = join(params.happyHomeDir, 'extensions', 'plugins', 'installed');
    const cacheDir = join(params.happyHomeDir, 'extensions', 'plugins', 'cache');
    const logsDir = join(params.happyHomeDir, 'extensions', 'plugins', 'logs');
    const locksDir = join(params.happyHomeDir, 'extensions', 'plugins', 'locks');

    await Promise.all([
        mkdir(stateDir, { recursive: true }),
        mkdir(installedDir, { recursive: true }),
        mkdir(cacheDir, { recursive: true }),
        mkdir(logsDir, { recursive: true }),
        mkdir(locksDir, { recursive: true }),
    ]);

    await writeFile(
        join(stateDir, 'plugin-state.v1.json'),
        JSON.stringify(
            {
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {
                    [params.pluginId]: {
                        source: {
                            kind: 'path',
                            locator: params.pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                            resolvedPath: params.pluginRoot,
                            manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
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
            },
            null,
            2,
        ),
        'utf8',
    );
}

describe('core e2e: plugin hook execution', () => {
    it('loads and executes a supported plugin hook handler through the executable runtime registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-e2e-'));
        const hookMarkerPath = join(testDir, 'hook-fired.txt');
        const probeScriptPath = join(testDir, 'plugin-hook-probe.mts');
        const tsxImportHookPath = resolveTsxImportHookPath();

        expect(tsxImportHookPath).not.toBeNull();
        if (!tsxImportHookPath) {
            throw new Error('tsx import hook could not be resolved');
        }

        try {
            const pluginId = 'acme.hook.integration';
            await writePluginFixture({ pluginRoot });
            await writeEnabledLocalPathPluginState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const runtimeRegistryUrl = pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'extensions', 'runtime', 'resolveExecutablePluginRuntimeRegistry.ts')).href;
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
                    'const handlers = runtimeRegistry.hookHandlersByHookId.get("backend.terminalRuntime.bindTranscript");',
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

            const spawnRes = spawnSync(process.execPath, ['--import', tsxImportHookPath, probeScriptPath], {
                cwd: repoRootDir(),
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
