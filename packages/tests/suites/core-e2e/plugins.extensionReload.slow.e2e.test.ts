import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import {
    writeBrokenActivationPluginFixture,
    writeEnabledLocalExtensionPackageState,
    writeReloadableActivationPluginFixture,
} from '../../src/testkit/extensions/localPackageFixture';

type PluginsReloadEnvelope = Readonly<{
    ok?: boolean;
    kind?: string;
    data?: Readonly<{
        activeGenerationId?: string;
        changedPluginIds?: readonly string[];
        registryStatus?: string;
        diagnosticsByPluginId?: Readonly<Record<string, readonly Readonly<{ code?: string }>[]>>
    }>;
    error?: Readonly<{
        code?: string;
        diagnostics?: readonly Readonly<{ code?: string; message?: string }>[];
    }>;
}>;

type PluginReloadToolProbeEnvelope = Readonly<{
    first?: Readonly<{
        ok?: boolean;
        result?: Readonly<{
            ok?: boolean;
            kind?: string;
            desiredGeneration?: string | null;
            appliedGeneration?: string | null;
        }>;
    }>;
    second?: Readonly<{
        ok?: boolean;
        result?: Readonly<{
            ok?: boolean;
            kind?: string;
            desiredGeneration?: string | null;
            appliedGeneration?: string | null;
        }>;
    }>;
}>;

type LastKnownGoodReloadProbeEnvelope = Readonly<{
    firstReload?: Readonly<{
        ok?: boolean;
        registryStatus?: string;
        activeGenerationId?: string | null;
    }>;
    failedReload?: Readonly<{
        ok?: boolean;
        registryStatus?: string;
        activeGenerationId?: string | null;
        diagnostics?: readonly Readonly<{ code?: string }>[] | null;
        diagnosticsByPluginId?: Readonly<Record<string, readonly Readonly<{ code?: string }>[]>> | null;
    }>;
    beforeFailure?: Readonly<{
        matched?: boolean;
        result?: Readonly<{
            ok?: boolean;
            result?: Readonly<{
                data?: Readonly<{ generation?: string }>;
            }>;
        }>;
    }>;
    afterFailure?: Readonly<{
        matched?: boolean;
        result?: Readonly<{
            ok?: boolean;
            result?: Readonly<{
                data?: Readonly<{ generation?: string }>;
            }>;
        }>;
    }>;
    controllerState?: Readonly<{
        generation?: number;
        hasActiveRegistry?: boolean;
    }>;
}>;

type SelfImprovingReloadProbeEnvelope = Readonly<{
    firstReload?: Readonly<{
        ok?: boolean;
        registryStatus?: string;
        activeGenerationId?: string | null;
        changedPluginIds?: readonly string[];
    }>;
    secondReload?: Readonly<{
        ok?: boolean;
        registryStatus?: string;
        activeGenerationId?: string | null;
        changedPluginIds?: readonly string[];
    }>;
    thirdReload?: Readonly<{
        ok?: boolean;
        registryStatus?: string;
        activeGenerationId?: string | null;
        changedPluginIds?: readonly string[];
    }>;
    firstAction?: Readonly<{
        matched?: boolean;
        result?: Readonly<{
            ok?: boolean;
            result?: Readonly<{
                data?: Readonly<{ generation?: string }>;
            }>;
        }>;
    }>;
    secondAction?: Readonly<{
        matched?: boolean;
        result?: Readonly<{
            ok?: boolean;
            result?: Readonly<{
                data?: Readonly<{ generation?: string }>;
            }>;
        }>;
    }>;
    thirdAction?: Readonly<{
        matched?: boolean;
        result?: Readonly<{
            ok?: boolean;
            result?: Readonly<{
                data?: Readonly<{ generation?: string }>;
            }>;
        }>;
    }>;
}>;

const CLI_RELOAD_ROUNDTRIP_TEST_TIMEOUT_MS = 90_000;
const RELOAD_PROBE_TEST_TIMEOUT_MS = 60_000;

function runPluginsReloadCommand(params: Readonly<{
    happyHomeDir: string;
}>): SpawnSyncReturns<string> {
    const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
    const repoNodeModulesPath = join(repoRootDir(), 'node_modules');
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
                NODE_PATH: repoNodeModulesPath,
                TSX_TSCONFIG_PATH: join(repoRootDir(), 'apps', 'cli', 'tsconfig.json'),
            },
            encoding: 'utf8',
            timeout: CLI_RELOAD_ROUNDTRIP_TEST_TIMEOUT_MS,
        },
    );
}

function parseReloadEnvelope(stdout: string): PluginsReloadEnvelope {
    return JSON.parse(stdout) as PluginsReloadEnvelope;
}

function buildProbeEnv(params: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return {
        ...process.env,
        NODE_PATH: join(repoRootDir(), 'node_modules'),
        ...params,
    };
}

function createReloadableDaemonModule(params: Readonly<{
    generation: string;
    actionId: string;
    activationMarkerPath: string;
    disposeMarkerPath: string;
}>): string {
    return [
        'import { appendFile } from "node:fs/promises";',
        '',
        'export async function activate(api) {',
        `  await appendFile(${JSON.stringify(params.activationMarkerPath)}, ${JSON.stringify(`activate:${params.generation}\n`)}, "utf8");`,
        '  api.registerAction({',
        `    id: ${JSON.stringify(params.actionId)},`,
        '    handler: async () => ({ ok: true, data: { generation: ' + JSON.stringify(params.generation) + ' } }),',
        '  });',
        '  api.onDispose(async () => {',
        `    await appendFile(${JSON.stringify(params.disposeMarkerPath)}, ${JSON.stringify(`dispose:${params.generation}\n`)}, "utf8");`,
        '  });',
        '}',
        '',
    ].join('\n');
}

describe('core e2e: plugin extension reload', () => {
    it('reloads a local trusted activation-runtime plugin and reactivates updated registrations', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-e2e-'));
        const activationMarkerPath = join(testDir, 'activation.log');
        const disposeMarkerPath = join(testDir, 'dispose.log');

        try {
            const pluginId = 'acme.reload.integration';
            const actionId = 'acme.reload.integration.action';
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
            const firstEnvelope = parseReloadEnvelope(firstReload.stdout);
            expect(firstEnvelope).toMatchObject({
                ok: true,
                kind: 'plugins_reload',
            });
            expect(firstEnvelope.data?.changedPluginIds).toContain(pluginId);
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:one\n');

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
            const secondEnvelope = parseReloadEnvelope(secondReload.stdout);
            expect(secondEnvelope).toMatchObject({
                ok: true,
                kind: 'plugins_reload',
            });
            expect(secondEnvelope.data?.changedPluginIds).toContain(pluginId);
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:two\n');
            await expect(readFile(disposeMarkerPath, 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, CLI_RELOAD_ROUNDTRIP_TEST_TIMEOUT_MS);

    it('fails closed when a later standalone reload activation fails without an active in-memory registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-lkg-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-lkg-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-lkg-e2e-'));
        const activationMarkerPath = join(testDir, 'activation.log');
        const disposeMarkerPath = join(testDir, 'dispose.log');

        try {
            const pluginId = 'acme.reload.lkg';
            await writeReloadableActivationPluginFixture({
                pluginRoot,
                pluginId,
                actionId: 'acme.reload.lkg.action',
                generation: 'good',
                activationMarkerPath,
                disposeMarkerPath,
            });
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const goodReload = runPluginsReloadCommand({ happyHomeDir });
            expect(goodReload.status, goodReload.stderr).toBe(0);
            const goodEnvelope = parseReloadEnvelope(goodReload.stdout);
            expect(goodEnvelope.ok).toBe(true);
            const goodGenerationId = goodEnvelope.data?.activeGenerationId;
            expect(goodGenerationId).toEqual(expect.any(String));

            await writeBrokenActivationPluginFixture({
                pluginRoot,
                pluginId,
                failureMessage: 'reload broke after a local edit',
            });

            const failedReload = runPluginsReloadCommand({ happyHomeDir });
            expect(failedReload.status, failedReload.stderr).toBe(1);
            const failedEnvelope = parseReloadEnvelope(failedReload.stdout);
            expect(failedEnvelope).toMatchObject({
                ok: false,
                kind: 'plugins_reload',
                error: {
                    code: 'reload_failed',
                },
            });
            expect(failedEnvelope.error?.diagnostics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: 'plugin_reload_failed',
                    }),
                ]),
            );
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:good\n');
            expect(goodGenerationId).toEqual(expect.any(String));
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, CLI_RELOAD_ROUNDTRIP_TEST_TIMEOUT_MS);

    it('keeps the last-known-good runtime registry active for plugin action execution after a failed reload in one process', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-lkg-active-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-lkg-active-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-lkg-active-e2e-'));
        const activationMarkerPath = join(testDir, 'activation.log');
        const disposeMarkerPath = join(testDir, 'dispose.log');
        const probeScriptPath = join(testDir, 'plugin-reload-last-known-good-probe.mts');

        try {
            const pluginId = 'acme.reload.last-known-good';
            const actionId = 'acme.reload.last-known-good.action';
            await writeReloadableActivationPluginFixture({
                pluginRoot,
                pluginId,
                actionId,
                generation: 'good',
                activationMarkerPath,
                disposeMarkerPath,
            });
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const reloadControllerUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'plugins',
                'runtime',
                'reload',
                'controller.ts',
            )).href;
            const actionExecutorUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'plugins',
                'projection',
                'actions',
                'execute.ts',
            )).href;
            const fixtureHelpersUrl = pathToFileURL(join(
                repoRootDir(),
                'packages',
                'tests',
                'src',
                'testkit',
                'extensions',
                'localPackageFixture.ts',
            )).href;
            const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
            const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');

            await writeFile(
                probeScriptPath,
                [
                    'const reloadControllerUrl = process.env.PLUGIN_RELOAD_CONTROLLER_URL;',
                    'const actionExecutorUrl = process.env.CLI_ACTION_EXECUTOR_URL;',
                    'const fixtureHelpersUrl = process.env.PLUGIN_FIXTURE_HELPERS_URL;',
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const pluginRoot = process.env.PLUGIN_ROOT;',
                    'const pluginId = process.env.PLUGIN_ID;',
                    'const actionId = process.env.PLUGIN_ACTION_ID;',
                    'if (!reloadControllerUrl) throw new Error("Missing PLUGIN_RELOAD_CONTROLLER_URL");',
                    'if (!actionExecutorUrl) throw new Error("Missing CLI_ACTION_EXECUTOR_URL");',
                    'if (!fixtureHelpersUrl) throw new Error("Missing PLUGIN_FIXTURE_HELPERS_URL");',
                    'if (!happyHomeDir) throw new Error("Missing HAPPIER_HOME_DIR");',
                    'if (!pluginRoot) throw new Error("Missing PLUGIN_ROOT");',
                    'if (!pluginId) throw new Error("Missing PLUGIN_ID");',
                    'if (!actionId) throw new Error("Missing PLUGIN_ACTION_ID");',
                    '',
                    'const { createPluginReloadController } = await import(reloadControllerUrl);',
                    'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
                    'const { writeBrokenActivationPluginFixture } = await import(fixtureHelpersUrl);',
                    'const pluginReloadController = createPluginReloadController({ happyHomeDir });',
                    '',
                    'const firstReload = await pluginReloadController.reload({ pluginId });',
                    'const beforeFailureLease = await pluginReloadController.acquireRuntimeRegistry();',
                    'const beforeFailure = await executePluginActionIfAvailable({',
                    '  runtimeRegistry: beforeFailureLease.registry,',
                    '  actionId,',
                    '  input: { phase: "before-failure" },',
                    '  context: { surface: "cli" },',
                    '});',
                    'await beforeFailureLease.release();',
                    'await writeBrokenActivationPluginFixture({',
                    '  pluginRoot,',
                    '  pluginId,',
                    '  failureMessage: "reload broke after a local edit",',
                    '});',
                    'const failedReload = await pluginReloadController.reload({ pluginId });',
                    'const afterFailureLease = await pluginReloadController.acquireRuntimeRegistry();',
                    'const afterFailure = await executePluginActionIfAvailable({',
                    '  runtimeRegistry: afterFailureLease.registry,',
                    '  actionId,',
                    '  input: { phase: "after-failure" },',
                    '  context: { surface: "cli" },',
                    '});',
                    'await afterFailureLease.release();',
                    'const controllerState = pluginReloadController.getState();',
                    'process.stdout.write(JSON.stringify({',
                    '  firstReload: {',
                    '    ok: firstReload.ok,',
                    '    registryStatus: firstReload.registryStatus,',
                    '    activeGenerationId: firstReload.activeGenerationId ?? null,',
                    '  },',
                    '  failedReload: {',
                    '    ok: failedReload.ok,',
                    '    registryStatus: failedReload.registryStatus,',
                    '    activeGenerationId: failedReload.activeGenerationId ?? null,',
                    '    diagnostics: failedReload.diagnostics ?? null,',
                    '    diagnosticsByPluginId: failedReload.diagnosticsByPluginId ?? null,',
                    '  },',
                    '  beforeFailure,',
                    '  afterFailure,',
                    '  controllerState: {',
                    '    generation: controllerState.generation,',
                    '    hasActiveRegistry: Boolean(controllerState.activeRegistry),',
                    '  },',
                    '}));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const spawnRes = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, probeScriptPath], {
                cwd: join(repoRootDir(), 'apps', 'cli'),
                env: buildProbeEnv({
                    HAPPIER_HOME_DIR: happyHomeDir,
                    PLUGIN_RELOAD_CONTROLLER_URL: reloadControllerUrl,
                    CLI_ACTION_EXECUTOR_URL: actionExecutorUrl,
                    PLUGIN_FIXTURE_HELPERS_URL: fixtureHelpersUrl,
                    PLUGIN_ROOT: pluginRoot,
                    PLUGIN_ID: pluginId,
                    PLUGIN_ACTION_ID: actionId,
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                }),
                encoding: 'utf8',
                timeout: RELOAD_PROBE_TEST_TIMEOUT_MS,
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            const parsed = JSON.parse(spawnRes.stdout) as LastKnownGoodReloadProbeEnvelope;
            expect(parsed.firstReload).toMatchObject({
                ok: true,
                registryStatus: 'active',
                activeGenerationId: expect.any(String),
            });
            expect(parsed.failedReload).toMatchObject({
                ok: true,
                registryStatus: 'last_known_good',
                activeGenerationId: parsed.firstReload?.activeGenerationId,
                diagnostics: [],
                diagnosticsByPluginId: {
                    [pluginId]: [
                        expect.objectContaining({
                            code: 'plugin_activation_failed',
                        }),
                    ],
                },
            });
            expect(parsed.failedReload?.diagnosticsByPluginId?.[pluginId]).toEqual([
                expect.objectContaining({
                    code: 'plugin_activation_failed',
                }),
            ]);
            expect(parsed.firstReload?.activeGenerationId).toEqual(expect.any(String));
            expect(parsed.failedReload?.activeGenerationId).toBe(parsed.firstReload?.activeGenerationId);
            expect(parsed.beforeFailure).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        generation: 'good',
                    },
                },
            });
            expect(parsed.afterFailure).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        generation: 'good',
                    },
                },
            });
            expect(parsed.controllerState).toEqual({
                generation: 1,
                hasActiveRegistry: true,
            });
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:good\n');
            await expect(readFile(disposeMarkerPath, 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, RELOAD_PROBE_TEST_TIMEOUT_MS);

    it('supports a self-improving local plugin loop across repeated edit, reload, and use iterations in one process', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-self-improving-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-self-improving-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-self-improving-e2e-'));
        const activationMarkerPath = join(testDir, 'activation.log');
        const disposeMarkerPath = join(testDir, 'dispose.log');
        const probeScriptPath = join(testDir, 'plugin-self-improving-probe.mts');

        try {
            const pluginId = 'acme.reload.self-improving';
            const actionId = 'acme.reload.self-improving.action';
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

            const reloadControllerUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'plugins',
                'runtime',
                'reload',
                'controller.ts',
            )).href;
            const actionExecutorUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'plugins',
                'projection',
                'actions',
                'execute.ts',
            )).href;
            const fixtureHelpersUrl = pathToFileURL(join(
                repoRootDir(),
                'packages',
                'tests',
                'src',
                'testkit',
                'extensions',
                'localPackageFixture.ts',
            )).href;
            const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
            const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');

            await writeFile(
                probeScriptPath,
                [
                    'const reloadControllerUrl = process.env.PLUGIN_RELOAD_CONTROLLER_URL;',
                    'const actionExecutorUrl = process.env.CLI_ACTION_EXECUTOR_URL;',
                    'const fixtureHelpersUrl = process.env.PLUGIN_FIXTURE_HELPERS_URL;',
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const pluginRoot = process.env.PLUGIN_ROOT;',
                    'const pluginId = process.env.PLUGIN_ID;',
                    'const actionId = process.env.PLUGIN_ACTION_ID;',
                    'if (!reloadControllerUrl) throw new Error("Missing PLUGIN_RELOAD_CONTROLLER_URL");',
                    'if (!actionExecutorUrl) throw new Error("Missing CLI_ACTION_EXECUTOR_URL");',
                    'if (!fixtureHelpersUrl) throw new Error("Missing PLUGIN_FIXTURE_HELPERS_URL");',
                    'if (!happyHomeDir) throw new Error("Missing HAPPIER_HOME_DIR");',
                    'if (!pluginRoot) throw new Error("Missing PLUGIN_ROOT");',
                    'if (!pluginId) throw new Error("Missing PLUGIN_ID");',
                    'if (!actionId) throw new Error("Missing PLUGIN_ACTION_ID");',
                    '',
                    'const { createPluginReloadController } = await import(reloadControllerUrl);',
                    'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
                    'const { writeReloadableActivationPluginFixture } = await import(fixtureHelpersUrl);',
                    'const pluginReloadController = createPluginReloadController({ happyHomeDir });',
                    '',
                    'const firstReload = await pluginReloadController.reload({ pluginId });',
                    'const firstLease = await pluginReloadController.acquireRuntimeRegistry();',
                    'const firstAction = await executePluginActionIfAvailable({',
                    '  runtimeRegistry: firstLease.registry,',
                    '  actionId,',
                    '  input: { phase: "one" },',
                    '  context: { surface: "cli" },',
                    '});',
                    'await firstLease.release();',
                    'await writeReloadableActivationPluginFixture({',
                    '  pluginRoot,',
                    '  pluginId,',
                    '  actionId,',
                    '  generation: "two",',
                    '  activationMarkerPath: process.env.ACTIVATION_MARKER_PATH,',
                    '  disposeMarkerPath: process.env.DISPOSE_MARKER_PATH,',
                    '});',
                    'const secondReload = await pluginReloadController.reload({ pluginId });',
                    'const secondLease = await pluginReloadController.acquireRuntimeRegistry();',
                    'const secondAction = await executePluginActionIfAvailable({',
                    '  runtimeRegistry: secondLease.registry,',
                    '  actionId,',
                    '  input: { phase: "two" },',
                    '  context: { surface: "cli" },',
                    '});',
                    'await secondLease.release();',
                    'await writeReloadableActivationPluginFixture({',
                    '  pluginRoot,',
                    '  pluginId,',
                    '  actionId,',
                    '  generation: "three",',
                    '  activationMarkerPath: process.env.ACTIVATION_MARKER_PATH,',
                    '  disposeMarkerPath: process.env.DISPOSE_MARKER_PATH,',
                    '});',
                    'const thirdReload = await pluginReloadController.reload({ pluginId });',
                    'const thirdLease = await pluginReloadController.acquireRuntimeRegistry();',
                    'const thirdAction = await executePluginActionIfAvailable({',
                    '  runtimeRegistry: thirdLease.registry,',
                    '  actionId,',
                    '  input: { phase: "three" },',
                    '  context: { surface: "cli" },',
                    '});',
                    'await thirdLease.release();',
                    'process.stdout.write(JSON.stringify({',
                    '  firstReload: {',
                    '    ok: firstReload.ok,',
                    '    registryStatus: firstReload.registryStatus,',
                    '    activeGenerationId: firstReload.activeGenerationId ?? null,',
                    '    changedPluginIds: firstReload.changedPluginIds ?? [],',
                    '  },',
                    '  secondReload: {',
                    '    ok: secondReload.ok,',
                    '    registryStatus: secondReload.registryStatus,',
                    '    activeGenerationId: secondReload.activeGenerationId ?? null,',
                    '    changedPluginIds: secondReload.changedPluginIds ?? [],',
                    '  },',
                    '  thirdReload: {',
                    '    ok: thirdReload.ok,',
                    '    registryStatus: thirdReload.registryStatus,',
                    '    activeGenerationId: thirdReload.activeGenerationId ?? null,',
                    '    changedPluginIds: thirdReload.changedPluginIds ?? [],',
                    '  },',
                    '  firstAction,',
                    '  secondAction,',
                    '  thirdAction,',
                    '}));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const spawnRes = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, probeScriptPath], {
                cwd: join(repoRootDir(), 'apps', 'cli'),
                env: buildProbeEnv({
                    HAPPIER_HOME_DIR: happyHomeDir,
                    PLUGIN_RELOAD_CONTROLLER_URL: reloadControllerUrl,
                    CLI_ACTION_EXECUTOR_URL: actionExecutorUrl,
                    PLUGIN_FIXTURE_HELPERS_URL: fixtureHelpersUrl,
                    PLUGIN_ROOT: pluginRoot,
                    PLUGIN_ID: pluginId,
                    PLUGIN_ACTION_ID: actionId,
                    ACTIVATION_MARKER_PATH: activationMarkerPath,
                    DISPOSE_MARKER_PATH: disposeMarkerPath,
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                }),
                encoding: 'utf8',
                timeout: RELOAD_PROBE_TEST_TIMEOUT_MS,
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            const parsed = JSON.parse(spawnRes.stdout) as SelfImprovingReloadProbeEnvelope;
            expect(parsed.firstReload).toMatchObject({
                ok: true,
                registryStatus: 'active',
                changedPluginIds: [pluginId],
                activeGenerationId: expect.any(String),
            });
            expect(parsed.secondReload).toMatchObject({
                ok: true,
                registryStatus: 'active',
                changedPluginIds: [pluginId],
                activeGenerationId: expect.any(String),
            });
            expect(parsed.thirdReload).toMatchObject({
                ok: true,
                registryStatus: 'active',
                changedPluginIds: [pluginId],
                activeGenerationId: expect.any(String),
            });
            expect(parsed.firstAction).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        generation: 'one',
                    },
                },
            });
            expect(parsed.secondAction).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        generation: 'two',
                    },
                },
            });
            expect(parsed.thirdAction).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        generation: 'three',
                    },
                },
            });
            expect(parsed.firstReload?.activeGenerationId).toEqual(expect.any(String));
            expect(parsed.secondReload?.activeGenerationId).toEqual(expect.any(String));
            expect(parsed.thirdReload?.activeGenerationId).toEqual(expect.any(String));
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:one\n');
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:two\n');
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:three\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, RELOAD_PROBE_TEST_TIMEOUT_MS);

    it('reloads a trusted local dev plugin through the agent-facing plugins_reload tool', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-tool-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-tool-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-tool-e2e-'));
        const activationMarkerPath = join(testDir, 'activation.log');
        const disposeMarkerPath = join(testDir, 'dispose.log');
        const probeScriptPath = join(testDir, 'plugin-reload-tool-probe.mts');
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');

        try {
            const pluginId = 'acme.reload.tool';
            const actionId = 'acme.reload.tool.action';
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

            const dispatchToolUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'agent',
                'tools',
                'happierTools',
                'dispatchBuiltInHappierTool.ts',
            )).href;
            const listToolsUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'agent',
                'tools',
                'happierTools',
                'listBuiltInHappierTools.ts',
            )).href;
            const pluginDevLoopActionsUrl = pathToFileURL(join(
                repoRootDir(),
                'apps',
                'cli',
                'src',
                'plugins',
                'devLoop',
                'actions.ts',
            )).href;
            const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
            const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');

            await writeFile(
                probeScriptPath,
                [
                    'import { writeFile } from "node:fs/promises";',
                    '',
                    'const dispatchToolUrl = process.env.DISPATCH_TOOL_URL;',
                    'const listToolsUrl = process.env.LIST_TOOLS_URL;',
                    'const pluginDevLoopActionsUrl = process.env.PLUGIN_DEV_LOOP_ACTIONS_URL;',
                    'const pluginId = process.env.PLUGIN_ID;',
                    'const daemonEntryPath = process.env.PLUGIN_DAEMON_ENTRY_PATH;',
                    'const generationTwoModule = process.env.PLUGIN_GENERATION_TWO_MODULE;',
                    'if (!dispatchToolUrl) throw new Error("Missing DISPATCH_TOOL_URL");',
                    'if (!listToolsUrl) throw new Error("Missing LIST_TOOLS_URL");',
                    'if (!pluginDevLoopActionsUrl) throw new Error("Missing PLUGIN_DEV_LOOP_ACTIONS_URL");',
                    'if (!pluginId) throw new Error("Missing PLUGIN_ID");',
                    'if (!daemonEntryPath) throw new Error("Missing PLUGIN_DAEMON_ENTRY_PATH");',
                    'if (!generationTwoModule) throw new Error("Missing PLUGIN_GENERATION_TWO_MODULE");',
                    '',
                    'const { dispatchBuiltInHappierTool } = await import(dispatchToolUrl);',
                    'const { listBuiltInHappierTools } = await import(listToolsUrl);',
                    'const { executePluginDevLoopAction } = await import(pluginDevLoopActionsUrl);',
                    'const toolNames = listBuiltInHappierTools({ surface: "agent" }).map((tool) => tool.name);',
                    'if (!toolNames.includes("plugins_reload")) {',
                    '  throw new Error("plugins_reload was not exposed to the agent tool catalog");',
                    '}',
                    '',
                    'const deps = {',
                    '  changeTitle: async () => ({ success: true }),',
                    '  executeActionByToolName: async (toolName, input) => {',
                    '    if (toolName !== "plugins_reload") {',
                    '      return { ok: false, errorCode: "unsupported", error: "unsupported" };',
                    '    }',
                    '    return {',
                    '      ok: true,',
                    '      result: await executePluginDevLoopAction({ actionId: "plugins.reload", input }),',
                    '    };',
                    '  },',
                    '};',
                    'const first = await dispatchBuiltInHappierTool({',
                    '  toolName: "plugins_reload",',
                    '  args: { pluginId },',
                    '  sessionId: "sess-1",',
                    '  surface: "agent",',
                    '  deps,',
                    '});',
                    'await writeFile(daemonEntryPath, generationTwoModule, "utf8");',
                    'const second = await dispatchBuiltInHappierTool({',
                    '  toolName: "plugins_reload",',
                    '  args: { pluginId },',
                    '  sessionId: "sess-1",',
                    '  surface: "agent",',
                    '  deps,',
                    '});',
                    'process.stdout.write(JSON.stringify({ first, second }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const spawnRes = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, probeScriptPath], {
                cwd: join(repoRootDir(), 'apps', 'cli'),
                env: buildProbeEnv({
                    HAPPIER_HOME_DIR: happyHomeDir,
                    DISPATCH_TOOL_URL: dispatchToolUrl,
                    LIST_TOOLS_URL: listToolsUrl,
                    PLUGIN_DEV_LOOP_ACTIONS_URL: pluginDevLoopActionsUrl,
                    PLUGIN_ID: pluginId,
                    PLUGIN_DAEMON_ENTRY_PATH: daemonEntryPath,
                    PLUGIN_GENERATION_TWO_MODULE: createReloadableDaemonModule({
                        generation: 'two',
                        actionId,
                        activationMarkerPath,
                        disposeMarkerPath,
                    }),
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                }),
                encoding: 'utf8',
                timeout: RELOAD_PROBE_TEST_TIMEOUT_MS,
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            const parsed = JSON.parse(spawnRes.stdout) as PluginReloadToolProbeEnvelope;
            expect(parsed.first).toMatchObject({
                ok: true,
                result: {
                    ok: true,
                    kind: 'plugins_reload',
                    desiredGeneration: expect.any(String),
                    appliedGeneration: expect.any(String),
                },
            });
            expect(parsed.second).toMatchObject({
                ok: true,
                result: {
                    ok: true,
                    kind: 'plugins_reload',
                    desiredGeneration: expect.any(String),
                    appliedGeneration: expect.any(String),
                },
            });
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:one\n');
            expect(await readFile(activationMarkerPath, 'utf8')).toContain('activate:two\n');
            expect(await readFile(disposeMarkerPath, 'utf8')).toContain('dispose:one\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, RELOAD_PROBE_TEST_TIMEOUT_MS);
});
