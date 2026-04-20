import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import {
    writeEnabledLocalExtensionPackageState,
    writeReloadableActivationPluginFixture,
} from '../../src/testkit/extensions/localPackageFixture';

type PluginsReloadEnvelope = Readonly<{
    ok?: boolean;
    kind?: string;
    data?: Readonly<{
        changedPluginIds?: readonly string[];
    }>;
}>;

type PluginActionExecutionEnvelope = Readonly<{
    matched?: boolean;
    result?: Readonly<{
        ok?: boolean;
        result?: Readonly<{
            data?: Readonly<{
                generation?: string;
            }>;
        }>;
    }>;
}>;

const CLI_RELOAD_TIMEOUT_MS = 90_000;
const CLI_ACTION_TIMEOUT_MS = 30_000;

function runPluginsReloadCommand(params: Readonly<{
    happyHomeDir: string;
}>): SpawnSyncReturns<string> {
    const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
    return spawnSync(
        process.execPath,
        [
            tsxCliPath,
            '--tsconfig',
            join(repoRootDir(), 'apps', 'cli', 'tsconfig.json'),
            join(repoRootDir(), 'apps', 'cli', 'src', 'index.ts'),
            'plugins',
            'reload',
            '--json',
        ],
        {
            cwd: join(repoRootDir(), 'apps', 'cli'),
            env: {
                ...process.env,
                CI: '1',
                HAPPIER_CLI_UPDATE_CHECK: '0',
                HAPPIER_HOME_DIR: params.happyHomeDir,
                TSX_TSCONFIG_PATH: join(repoRootDir(), 'apps', 'cli', 'tsconfig.json'),
            },
            encoding: 'utf8',
            timeout: CLI_RELOAD_TIMEOUT_MS,
        },
    );
}

function parseReloadEnvelope(stdout: string): PluginsReloadEnvelope {
    return JSON.parse(stdout) as PluginsReloadEnvelope;
}

async function writeActionProbeScript(params: Readonly<{
    probeScriptPath: string;
}>): Promise<void> {
    await writeFile(
        params.probeScriptPath,
        [
            'const actionExecutorUrl = process.env.CLI_ACTION_EXECUTOR_URL;',
            'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
            'const actionId = process.env.PLUGIN_ACTION_ID;',
            'const iteration = process.env.PLUGIN_ITERATION;',
            'if (!actionExecutorUrl) throw new Error("Missing CLI_ACTION_EXECUTOR_URL");',
            'if (!happyHomeDir) throw new Error("Missing HAPPIER_HOME_DIR");',
            'if (!actionId) throw new Error("Missing PLUGIN_ACTION_ID");',
            'if (!iteration) throw new Error("Missing PLUGIN_ITERATION");',
            '',
            'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
            '',
            'const result = await executePluginActionIfAvailable({',
            '  happyHomeDir,',
            '  actionId,',
            '  input: { iteration },',
            '  context: { surface: "cli" },',
            '});',
            'process.stdout.write(JSON.stringify(result));',
            '',
        ].join('\n'),
        'utf8',
    );
}

function runActionProbe(params: Readonly<{
    happyHomeDir: string;
    actionId: string;
    iteration: string;
    probeScriptPath: string;
}>): PluginActionExecutionEnvelope {
    const actionExecutorUrl = pathToFileURL(join(
        repoRootDir(),
        'apps',
        'cli',
        'src',
        'extensions',
        'actions',
        'execute.ts',
    )).href;
    const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
    const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
    const spawnRes = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, params.probeScriptPath], {
        cwd: join(repoRootDir(), 'apps', 'cli'),
        env: {
            ...process.env,
            CLI_ACTION_EXECUTOR_URL: actionExecutorUrl,
            HAPPIER_HOME_DIR: params.happyHomeDir,
            PLUGIN_ACTION_ID: params.actionId,
            PLUGIN_ITERATION: params.iteration,
            TSX_TSCONFIG_PATH: cliTsconfigPath,
        },
        encoding: 'utf8',
        timeout: CLI_ACTION_TIMEOUT_MS,
    });

    expect(spawnRes.status, spawnRes.stderr).toBe(0);
    return JSON.parse(spawnRes.stdout) as PluginActionExecutionEnvelope;
}

describe('core e2e: self-improving local plugin iteration', () => {
    it('supports repeated local edit, reload, and use iterations through the canonical local plugin workflow', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-self-improving-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-self-improving-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-self-improving-e2e-'));
        const activationMarkerPath = join(testDir, 'activation.log');
        const disposeMarkerPath = join(testDir, 'dispose.log');
        const probeScriptPath = join(testDir, 'plugin-action-probe.mts');

        try {
            const pluginId = 'acme.self-improving.plugin';
            const actionId = 'acme.self-improving.plugin.action';
            await writeActionProbeScript({ probeScriptPath });

            await writeReloadableActivationPluginFixture({
                pluginRoot,
                pluginId,
                actionId,
                generation: 'one',
                activationMarkerPath,
                disposeMarkerPath,
            });
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const firstReload = runPluginsReloadCommand({ happyHomeDir });
            expect(firstReload.status, firstReload.stderr).toBe(0);
            expect(parseReloadEnvelope(firstReload.stdout)).toMatchObject({
                ok: true,
                kind: 'plugins_reload',
                data: {
                    changedPluginIds: [pluginId],
                },
            });
            expect(runActionProbe({
                happyHomeDir,
                actionId,
                iteration: 'one',
                probeScriptPath,
            })).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        data: {
                            generation: 'one',
                        },
                    },
                },
            });

            await writeReloadableActivationPluginFixture({
                pluginRoot,
                pluginId,
                actionId,
                generation: 'two',
                activationMarkerPath,
                disposeMarkerPath,
            });
            const secondReload = runPluginsReloadCommand({ happyHomeDir });
            expect(secondReload.status, secondReload.stderr).toBe(0);
            expect(parseReloadEnvelope(secondReload.stdout)).toMatchObject({
                ok: true,
                kind: 'plugins_reload',
                data: {
                    changedPluginIds: [pluginId],
                },
            });
            expect(runActionProbe({
                happyHomeDir,
                actionId,
                iteration: 'two',
                probeScriptPath,
            })).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        data: {
                            generation: 'two',
                        },
                    },
                },
            });

            await writeReloadableActivationPluginFixture({
                pluginRoot,
                pluginId,
                actionId,
                generation: 'three',
                activationMarkerPath,
                disposeMarkerPath,
            });
            const thirdReload = runPluginsReloadCommand({ happyHomeDir });
            expect(thirdReload.status, thirdReload.stderr).toBe(0);
            expect(parseReloadEnvelope(thirdReload.stdout)).toMatchObject({
                ok: true,
                kind: 'plugins_reload',
                data: {
                    changedPluginIds: [pluginId],
                },
            });
            expect(runActionProbe({
                happyHomeDir,
                actionId,
                iteration: 'three',
                probeScriptPath,
            })).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        data: {
                            generation: 'three',
                        },
                    },
                },
            });

            const activationLog = await readFile(activationMarkerPath, 'utf8');
            expect(activationLog).toContain('activate:one\n');
            expect(activationLog).toContain('activate:two\n');
            expect(activationLog).toContain('activate:three\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 120_000);
});
