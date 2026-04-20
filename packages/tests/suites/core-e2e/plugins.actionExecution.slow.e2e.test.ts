import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import {
    writeActivatedActionExecutionPluginFixture,
    writeEnabledLocalExtensionPackageState,
} from '../../src/testkit/extensions/localPackageFixture';

describe('core e2e: plugin action execution', () => {
    it('executes a local trusted activation-time plugin action through the daemon extension action executor', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-action-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-action-e2e-'));
        const actionMarkerPath = join(testDir, 'action-fired.txt');
        const probeScriptPath = join(testDir, 'plugin-action-probe.mts');

        try {
            const pluginId = 'acme.action.integration';
            const actionId = 'acme.action.integration.run';
            await writeActivatedActionExecutionPluginFixture({
                pluginRoot,
                pluginId,
                actionId,
                markerPath: actionMarkerPath,
            });
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId,
            });

            const actionExecutorUrl = pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'extensions', 'actions', 'execute.ts')).href;
            const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
            const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');

            await writeFile(
                probeScriptPath,
                [
                    'const actionExecutorUrl = process.env.CLI_ACTION_EXECUTOR_URL;',
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const actionId = process.env.PLUGIN_ACTION_ID;',
                    'if (!actionExecutorUrl) throw new Error("Missing CLI_ACTION_EXECUTOR_URL");',
                    'if (!happyHomeDir) throw new Error("Missing HAPPIER_HOME_DIR");',
                    'if (!actionId) throw new Error("Missing PLUGIN_ACTION_ID");',
                    '',
                    'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
                    '',
                    'const result = await executePluginActionIfAvailable({',
                    '  happyHomeDir,',
                    '  actionId,',
                    '  input: { source: "core-e2e" },',
                    '  context: { surface: "cli" },',
                    '});',
                    'if (result.matched !== true || result.result?.ok !== true || result.result.result?.data?.value !== "plugin-action-fired") {',
                    '  throw new Error(`Unexpected action execution result: ${JSON.stringify(result)}`);',
                    '}',
                    'process.stdout.write(JSON.stringify(result));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const spawnRes = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, probeScriptPath], {
                cwd: join(repoRootDir(), 'apps', 'cli'),
                env: {
                    ...process.env,
                    CLI_ACTION_EXECUTOR_URL: actionExecutorUrl,
                    HAPPIER_HOME_DIR: happyHomeDir,
                    PLUGIN_ACTION_ID: actionId,
                    TSX_TSCONFIG_PATH: cliTsconfigPath,
                },
                encoding: 'utf8',
                timeout: 30_000,
            });

            expect(spawnRes.status, spawnRes.stderr).toBe(0);
            const parsed = JSON.parse(spawnRes.stdout) as Readonly<{
                matched?: boolean;
                result?: Readonly<{
                    ok?: boolean;
                    result?: Readonly<{
                        data?: Readonly<{ value?: string }>;
                    }>;
                }>;
            }>;
            expect(parsed).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: {
                        data: {
                            value: 'plugin-action-fired',
                        },
                    },
                },
            });
            expect(await readFile(actionMarkerPath, 'utf8')).toBe('plugin-action-fired\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 30_000);
});
