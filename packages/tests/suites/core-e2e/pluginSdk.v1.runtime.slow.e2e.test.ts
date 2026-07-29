import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import {
    createPluginSdkV1Manifest,
    createReloadablePluginSdkV1DaemonModule,
    writeEnabledPluginSdkV1State,
    writePluginSdkV1Fixture,
} from '../../src/testkit/plugins/pluginSdkV1Fixture';

type ProbeEnvelope = Readonly<Record<string, unknown>>;

function runCliSourceProbe(params: Readonly<{
    scriptPath: string;
    env: Readonly<Record<string, string>>;
    timeoutMs?: number;
}>): ProbeEnvelope {
    const cliTsconfigPath = join(repoRootDir(), 'apps', 'cli', 'tsconfig.json');
    const tsxCliPath = join(repoRootDir(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
    const result = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', cliTsconfigPath, params.scriptPath], {
        cwd: join(repoRootDir(), 'apps', 'cli'),
        env: {
            ...process.env,
            NODE_PATH: join(repoRootDir(), 'node_modules'),
            TSX_TSCONFIG_PATH: cliTsconfigPath,
            ...params.env,
        },
        encoding: 'utf8',
        timeout: params.timeoutMs ?? 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ProbeEnvelope;
}

describe('core e2e: plugin SDK v1 runtime', () => {
    it('loads a local trusted plugin and exercises action, tool, hook, and disposal seams', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-sdk-v1-runtime-probe.mts');
        const activationLogPath = join(testDir, 'activation.log');
        const hookLogPath = join(testDir, 'hook.log');
        const disposalLogPath = join(testDir, 'disposal.log');

        try {
            const pluginId = 'acme.sdk.lifecycle';
            const actionId = 'acme.sdk.lifecycle.action';
            const toolId = 'acme.sdk.lifecycle.tool';
            await writePluginSdkV1Fixture({
                pluginRoot,
                manifest: createPluginSdkV1Manifest({
                    pluginId,
                    uses: ['actions', 'tools', 'hooks'],
                    permissions: [],
                    contributes: {
                        actions: [
                            {
                                id: actionId,
                                title: 'Lifecycle Action',
                                scopes: ['global'],
                                surfaces: ['cli', 'agent'],
                                placement: 'commandPalette',
                                inputSchema: { type: 'object', additionalProperties: true },
                                handler: { target: 'daemon', registrationId: actionId },
                                dangerLevel: 'safe',
                            },
                        ],
                        tools: [
                            {
                                id: toolId,
                                name: 'acme_sdk_lifecycle_tool',
                                title: 'Lifecycle Tool',
                                safety: 'safe',
                                surfaces: ['cli', 'agent'],
                                inputSchema: { type: 'object', additionalProperties: true },
                                handler: { target: 'plugin', exportName: 'executeTool' },
                            },
                        ],
                        hooks: [
                            {
                                id: 'session.input.transform',
                                hookApiVersion: 1,
                                category: 'augmentation',
                                scope: 'session',
                                executionKind: 'augment',
                                handler: { target: 'plugin', exportName: 'transformInput' },
                            },
                        ],
                    },
                }),
                daemonModuleContents: [
                    'import { appendFile } from "node:fs/promises";',
                    '',
                    `const activationLogPath = ${JSON.stringify(activationLogPath)};`,
                    `const hookLogPath = ${JSON.stringify(hookLogPath)};`,
                    `const disposalLogPath = ${JSON.stringify(disposalLogPath)};`,
                    '',
                    'export async function activate(host) {',
                    '  await appendFile(activationLogPath, "activate\\n", "utf8");',
                    `  host.registerAction({ id: ${JSON.stringify(actionId)}, handler: async (request) => ({ ok: true, data: { kind: "action", surface: request.context.surface, input: request.input } }) });`,
                    '  host.onDispose(async () => appendFile(disposalLogPath, "dispose\\n", "utf8"));',
                    '}',
                    '',
                    'export async function executeTool(request) {',
                    '  return { ok: true, data: { kind: "tool", surface: request.context.surface, input: request.input } };',
                    '}',
                    '',
                    'export async function transformInput(event) {',
                    '  await appendFile(hookLogPath, `${event.payload.text}\\n`, "utf8");',
                    '  return { ...event.payload, text: `rewritten:${event.payload.text}`, meta: { ...(event.payload.meta ?? {}), plugin: "acme" } };',
                    '}',
                    '',
                ].join('\n'),
            });
            await writeEnabledPluginSdkV1State({
                happyHomeDir,
                pluginRoot,
                pluginId,
                devWatch: true,
            });

            await writeFile(
                probeScriptPath,
                [
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const pluginId = process.env.PLUGIN_ID;',
                    'const actionId = process.env.ACTION_ID;',
                    'const toolId = process.env.TOOL_ID;',
                    'if (!happyHomeDir || !pluginId || !actionId || !toolId) throw new Error("missing probe env");',
                    'const runtimeRegistryUrl = process.env.RUNTIME_REGISTRY_URL;',
                    'const actionExecutorUrl = process.env.ACTION_EXECUTOR_URL;',
                    'const hookDispatcherUrl = process.env.HOOK_DISPATCHER_URL;',
                    'const reloadControllerUrl = process.env.RELOAD_CONTROLLER_URL;',
                    'const devLoopActionsUrl = process.env.DEV_LOOP_ACTIONS_URL;',
                    'if (!runtimeRegistryUrl || !actionExecutorUrl || !hookDispatcherUrl || !reloadControllerUrl || !devLoopActionsUrl) throw new Error("missing module env");',
                    'const { createPluginReloadController } = await import(reloadControllerUrl);',
                    'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
                    'const { dispatchPluginHookEvent } = await import(hookDispatcherUrl);',
                    'const { executePluginDevLoopAction } = await import(devLoopActionsUrl);',
                    'const controller = createPluginReloadController({ happyHomeDir, publishInstalledManifestProjections: async () => {}, dispatchReloadHookEvent: async () => {} });',
                    'const initialReload = await controller.reload({ pluginId });',
                    'const runtimeRegistry = initialReload.registry;',
                    'if (!runtimeRegistry) throw new Error("plugin runtime registry unavailable");',
                    'const cliAction = await executePluginActionIfAvailable({ runtimeRegistry, actionId, input: { source: "cli" }, context: { surface: "cli" } });',
                    'const agentAction = await executePluginActionIfAvailable({ runtimeRegistry, actionId, input: { source: "agent" }, context: { surface: "agent" } });',
                    'const toolProjected = runtimeRegistry.contributes.tools.some((tool) => tool.definition.id === toolId && tool.definition.surfaces.agent === true);',
                    'const toolAction = await executePluginActionIfAvailable({ runtimeRegistry, actionId: toolId, input: { source: "tool" }, context: { surface: "cli" } });',
                    'const hook = await dispatchPluginHookEvent({',
                    '  runtimeRegistry,',
                    '  event: { hookVersion: 1, eventId: "session.input.transform", category: "augmentation", scope: "session", happySessionId: "session-1", timestampMs: 1700000000000, payload: { sessionId: "session-1", localId: "local-1", text: "hello", meta: {}, timestampMs: 1700000000000 } },',
                    '});',
                    'const uninstall = await executePluginDevLoopAction({ actionId: "plugins.uninstall", input: { pluginId }, happyHomeDir, reload: controller.reload.bind(controller) });',
                    'await controller.shutdown({ timeoutMs: 2000 });',
                    'process.stdout.write(JSON.stringify({ initialReload, activated: runtimeRegistry.activatedPluginIds.has(pluginId), cliAction, agentAction, toolProjected, toolAction, hook, uninstall }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const parsed = runCliSourceProbe({
                scriptPath: probeScriptPath,
                env: {
                    HAPPIER_HOME_DIR: happyHomeDir,
                    PLUGIN_ID: pluginId,
                    ACTION_ID: actionId,
                    TOOL_ID: toolId,
                    RUNTIME_REGISTRY_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'resolveExecutablePluginRuntimeRegistry.ts')).href,
                    ACTION_EXECUTOR_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'projection', 'actions', 'execute.ts')).href,
                    HOOK_DISPATCHER_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'hooks', 'execution', 'dispatchPluginHookEvent.ts')).href,
                    RELOAD_CONTROLLER_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'reload', 'controller.ts')).href,
                    DEV_LOOP_ACTIONS_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'devLoop', 'actions.ts')).href,
                },
            });

            expect(parsed).toMatchObject({
                initialReload: { ok: true, registryStatus: 'active', affectedPluginIds: [pluginId] },
                activated: true,
                cliAction: { matched: true, result: { ok: true, result: { kind: 'action', surface: 'cli', input: { source: 'cli' } } } },
                agentAction: { matched: true, result: { ok: true, result: { kind: 'action', surface: 'agent', input: { source: 'agent' } } } },
                toolProjected: true,
                toolAction: { matched: true, result: { ok: true, result: { kind: 'tool', surface: 'cli', input: { source: 'tool' } } } },
                hook: {
                    eventId: 'session.input.transform',
                    aggregate: {
                        result: {
                            text: 'rewritten:hello',
                            meta: { plugin: 'acme' },
                        },
                    },
                },
                uninstall: {
                    ok: true,
                    kind: 'plugins_uninstall',
                    plugin: { pluginId },
                    reload: {
                        ok: true,
                        registryStatus: 'active',
                        affectedPluginIds: [pluginId],
                    },
                },
            });
            const storeRoot = join(happyHomeDir, 'plugins', 'plugins');
            const commit = JSON.parse(
                await readFile(join(storeRoot, 'state', 'plugin-registry-current.v1.json'), 'utf8'),
            ) as {
                installationState: { revisionId: string };
            };
            const installationState = JSON.parse(
                await readFile(
                    join(
                        storeRoot,
                        'state-revisions',
                        commit.installationState.revisionId,
                        'plugin-installations.v1.json',
                    ),
                    'utf8',
                ),
            ) as {
                runtimeCatalog: { plugins: Record<string, unknown> };
            };
            expect(installationState.runtimeCatalog.plugins[pluginId]).toBeUndefined();
            expect(await readFile(activationLogPath, 'utf8')).toBe('activate\n');
            expect(await readFile(hookLogPath, 'utf8')).toBe('hello\n');
            expect(await readFile(disposalLogPath, 'utf8')).toBe('dispose\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 90_000);

    it('writes and reads plugin-local settings through the daemon projection handler when settings are present', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-settings-home-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-settings-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-sdk-v1-settings-probe.mts');

        try {
            const pluginId = 'acme.sdk.settings';
            const settingId = 'endpoint';
            await writeFile(
                probeScriptPath,
                [
                    'const pluginId = process.env.PLUGIN_ID;',
                    'const settingId = process.env.SETTING_ID;',
                    'if (!pluginId || !settingId) throw new Error("missing probe env");',
                    'const createRegistryUrl = process.env.CREATE_REGISTRY_URL;',
                    'const runtimeRegistryUrl = process.env.RUNTIME_REGISTRY_URL;',
                    'const projectionHandlerUrl = process.env.PROJECTION_HANDLER_URL;',
                    'if (!createRegistryUrl || !runtimeRegistryUrl || !projectionHandlerUrl) throw new Error("missing module env");',
                    'const { createResolvedContributionRegistry } = await import(createRegistryUrl);',
                    'const { resolveExecutablePluginRuntimeRegistry } = await import(runtimeRegistryUrl);',
                    'const { registerDaemonContributionRegistryProjectionHandler, invalidateDaemonContributionRegistryProjectionCache } = await import(projectionHandlerUrl);',
                    'const contributes = createResolvedContributionRegistry({',
                    '  agents: Object.freeze([]),',
                    '  agentRuntimes: Object.freeze([]),',
                    '  settings: Object.freeze([',
                    '    Object.freeze({',
                    '      provenance: "external",',
                    '      source: { kind: "path" },',
                    '      pluginId,',
                    '      manifestPath: "/tmp/plugin.json",',
                    '      manifestDigest: "sha256:settings",',
                    '      daemonEntryPath: null,',
                    '      definition: {',
                    '        id: `${pluginId}.settings`,',
                    '        fields: [',
                    '          {',
                    '            id: settingId,',
                    '            kind: "settings.field",',
                    '            version: "1.0.0",',
                    '            valueSchema: { type: "string" },',
                    '            control: "text",',
                    '            displayKey: "plugins.acmeSdkSettings.endpoint.label",',
                    '            capabilityGates: [],',
                    '            permissionGates: [],',
                    '            redaction: "none",',
                    '            clearWhenEmpty: "persist",',
                    '            hidden: false,',
                    '          },',
                    '        ],',
                    '      },',
                    '    }),',
                    '  ]),',
                    '});',
                    'const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ contributes });',
                    'invalidateDaemonContributionRegistryProjectionCache();',
                    'const handlers = new Map();',
                    'registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, { resolveRuntimeRegistry: async () => runtimeRegistry, resolveGeneration: async () => 1, resolveInstalledPackages: async () => [] });',
                    'const setSettings = handlers.get("daemon.plugins.settings.set");',
                    'const getSettings = handlers.get("daemon.plugins.settings.get");',
                    'if (typeof setSettings !== "function" || typeof getSettings !== "function") throw new Error("missing settings handlers");',
                    'const writtenSettings = await setSettings({ machineId: "machine-1", pluginId, fieldId: settingId, value: "https://plugin.example.test" });',
                    'const readSettings = await getSettings({ machineId: "machine-1", pluginId });',
                    'await runtimeRegistry.dispose({ timeoutMs: 2000 });',
                    'process.stdout.write(JSON.stringify({ writtenSettings, readSettings }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const parsed = runCliSourceProbe({
                scriptPath: probeScriptPath,
                env: {
                    HAPPIER_HOME_DIR: happyHomeDir,
                    PLUGIN_ID: pluginId,
                    SETTING_ID: settingId,
                    CREATE_REGISTRY_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'projection', 'registry', 'createResolvedContributionRegistry.ts')).href,
                    RUNTIME_REGISTRY_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'resolveExecutablePluginRuntimeRegistry.ts')).href,
                    PROJECTION_HANDLER_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'rpc', 'handlers', 'daemonContributionRegistryProjection.ts')).href,
                },
            });

            expect(parsed).toMatchObject({
                writtenSettings: { values: { endpoint: 'https://plugin.example.test' } },
                readSettings: { values: { endpoint: 'https://plugin.example.test' } },
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 90_000);

    it('reloads a dev plugin and rolls back syntax-error reloads to last known good', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-reload-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-reload-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-reload-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-sdk-v1-reload-probe.mts');
        const activationLogPath = join(testDir, 'activation.log');
        const disposalLogPath = join(testDir, 'disposal.log');

        try {
            const pluginId = 'acme.sdk.reload';
            const actionId = 'acme.sdk.reload.action';
            await writePluginSdkV1Fixture({
                pluginRoot,
                manifest: createPluginSdkV1Manifest({
                    pluginId,
                    uses: ['actions'],
                    permissions: [],
                    contributes: {
                        actions: [
                            {
                                id: actionId,
                                title: 'Reload Action',
                                scopes: ['global'],
                                surfaces: ['cli'],
                                placement: 'commandPalette',
                                handler: { target: 'daemon', registrationId: actionId },
                                dangerLevel: 'safe',
                            },
                        ],
                    },
                }),
                daemonModuleContents: createReloadablePluginSdkV1DaemonModule({
                    actionId,
                    generation: 'one',
                    activationLogPath,
                    disposalLogPath,
                }),
            });
            await writeEnabledPluginSdkV1State({
                happyHomeDir,
                pluginRoot,
                pluginId,
                devWatch: true,
            });

            await writeFile(
                probeScriptPath,
                [
                    'import { writeFile } from "node:fs/promises";',
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const pluginId = process.env.PLUGIN_ID;',
                    'const actionId = process.env.ACTION_ID;',
                    'const daemonEntryPath = process.env.DAEMON_ENTRY_PATH;',
                    'const activationLogPath = process.env.ACTIVATION_LOG_PATH;',
                    'const disposalLogPath = process.env.DISPOSAL_LOG_PATH;',
                    'if (!happyHomeDir || !pluginId || !actionId || !daemonEntryPath || !activationLogPath || !disposalLogPath) throw new Error("missing probe env");',
                    'const reloadControllerUrl = process.env.RELOAD_CONTROLLER_URL;',
                    'const actionExecutorUrl = process.env.ACTION_EXECUTOR_URL;',
                    'if (!reloadControllerUrl || !actionExecutorUrl) throw new Error("missing module env");',
                    'const { createPluginReloadController } = await import(reloadControllerUrl);',
                    'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
                    'const controller = createPluginReloadController({ happyHomeDir, publishInstalledManifestProjections: async () => {}, dispatchReloadHookEvent: async () => {} });',
                    'async function runAction(registry) { return await executePluginActionIfAvailable({ runtimeRegistry: registry, actionId, input: {}, context: { surface: "cli" } }); }',
                    'function moduleForGeneration(generation) { return [',
                    '  "import { appendFile } from \\"node:fs/promises\\";",',
                    '  `const activationLogPath = ${JSON.stringify(activationLogPath)};`,',
                    '  `const disposalLogPath = ${JSON.stringify(disposalLogPath)};`,',
                    '  "export async function activate(host) {",',
                    '  `  await appendFile(activationLogPath, ${JSON.stringify(`activate:${generation}\\n`)}, \\"utf8\\");`,',
                    '  `  host.registerAction({ id: ${JSON.stringify(actionId)}, handler: async () => ({ ok: true, data: { generation: ${JSON.stringify(generation)} } }) });`,',
                    '  `  host.onDispose(async () => appendFile(disposalLogPath, ${JSON.stringify(`dispose:${generation}\\n`)}, \\"utf8\\"));`,',
                    '  "}",',
                    '  "",',
                    '].join("\\n"); }',
                    'const firstReload = await controller.reload({ pluginId });',
                    'const firstAction = await runAction(firstReload.registry);',
                    'await writeFile(daemonEntryPath, moduleForGeneration("two"), "utf8");',
                    'const secondReload = await controller.reload({ pluginId });',
                    'const secondAction = await runAction(secondReload.registry);',
                    'await writeFile(daemonEntryPath, "export async function activate(host) {\\n  host.registerAction({ id: \\"broken\\", handler: async () => ({ ok: true, data: null }) });\\n", "utf8");',
                    'const failedReload = await controller.reload({ pluginId });',
                    'const rollbackAction = await runAction(failedReload.registry);',
                    'await controller.shutdown({ timeoutMs: 2000 });',
                    'process.stdout.write(JSON.stringify({ firstReload, firstAction, secondReload, secondAction, failedReload, rollbackAction }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const parsed = runCliSourceProbe({
                scriptPath: probeScriptPath,
                timeoutMs: 90_000,
                env: {
                    HAPPIER_HOME_DIR: happyHomeDir,
                    PLUGIN_ID: pluginId,
                    ACTION_ID: actionId,
                    DAEMON_ENTRY_PATH: join(pluginRoot, 'daemon.mjs'),
                    ACTIVATION_LOG_PATH: activationLogPath,
                    DISPOSAL_LOG_PATH: disposalLogPath,
                    RELOAD_CONTROLLER_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'reload', 'controller.ts')).href,
                    ACTION_EXECUTOR_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'projection', 'actions', 'execute.ts')).href,
                },
            });

            expect(parsed).toMatchObject({
                firstReload: { ok: true, registryStatus: 'active' },
                firstAction: { matched: true, result: { ok: true, result: { generation: 'one' } } },
                secondReload: { ok: true, registryStatus: 'active' },
                secondAction: { matched: true, result: { ok: true, result: { generation: 'two' } } },
                failedReload: { ok: true, registryStatus: 'last_known_good' },
                rollbackAction: { matched: true, result: { ok: true, result: { generation: 'two' } } },
            });
            const activationLog = await readFile(activationLogPath, 'utf8');
            expect(activationLog).toContain('activate:one\n');
            expect(activationLog).toContain('activate:two\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 120_000);

    it('rewrites session input and augments agent context through final interception hooks', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-hooks-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-hooks-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-hooks-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-sdk-v1-hooks-probe.mts');

        try {
            const pluginId = 'acme.sdk.intercept';
            await writePluginSdkV1Fixture({
                pluginRoot,
                manifest: createPluginSdkV1Manifest({
                    pluginId,
                    uses: ['hooks'],
                    contributes: {
                        hooks: [
                            {
                                id: 'session.input.transform',
                                hookApiVersion: 1,
                                category: 'augmentation',
                                scope: 'session',
                                executionKind: 'augment',
                                handler: { target: 'plugin', exportName: 'transformInput' },
                                priority: 1,
                            },
                            {
                                id: 'agent.context.before',
                                hookApiVersion: 1,
                                category: 'augmentation',
                                scope: 'agent',
                                executionKind: 'augment',
                                handler: { target: 'plugin', exportName: 'augmentContext' },
                                priority: 1,
                            },
                        ],
                    },
                }),
                daemonModuleContents: [
                    'export async function activate() {}',
                    'export async function transformInput(event) {',
                    '  return { ...event.payload, text: `[sdk:${event.payload.text}]`, meta: { ...(event.payload.meta ?? {}), intercepted: true } };',
                    '}',
                    'export async function augmentContext(event) {',
                    '  return { ...event.payload, prompt: `${event.payload.prompt}\\nPlugin context: enabled`, messages: [...event.payload.messages, { role: "system", content: "plugin-added-context" }] };',
                    '}',
                    '',
                ].join('\n'),
            });
            await writeEnabledPluginSdkV1State({ happyHomeDir, pluginRoot, pluginId });

            await writeFile(
                probeScriptPath,
                [
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const runtimeRegistryUrl = process.env.RUNTIME_REGISTRY_URL;',
                    'const hookDispatcherUrl = process.env.HOOK_DISPATCHER_URL;',
                    'if (!happyHomeDir || !runtimeRegistryUrl || !hookDispatcherUrl) throw new Error("missing probe env");',
                    'const { resolveExecutablePluginRuntimeRegistry } = await import(runtimeRegistryUrl);',
                    'const { dispatchPluginHookEvent } = await import(hookDispatcherUrl);',
                    'const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });',
                    'const input = await dispatchPluginHookEvent({ runtimeRegistry, event: { hookVersion: 1, eventId: "session.input.transform", category: "augmentation", scope: "session", happySessionId: "session-1", timestampMs: 1700000000000, payload: { sessionId: "session-1", localId: "local-1", text: "inspect", meta: {}, timestampMs: 1700000000000 } } });',
                    'const context = await dispatchPluginHookEvent({ runtimeRegistry, event: { hookVersion: 1, eventId: "agent.context.before", category: "augmentation", scope: "agent", happySessionId: "session-1", agentId: "codex", timestampMs: 1700000000000, payload: { sessionId: "session-1", agentId: "codex", runtimeFamily: "hostSession", prompt: "base prompt", messages: [{ role: "user", content: "hello" }], timestampMs: 1700000000000 } } });',
                    'await runtimeRegistry.dispose({ timeoutMs: 2000 });',
                    'process.stdout.write(JSON.stringify({ input, context }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const parsed = runCliSourceProbe({
                scriptPath: probeScriptPath,
                env: {
                    HAPPIER_HOME_DIR: happyHomeDir,
                    RUNTIME_REGISTRY_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'resolveExecutablePluginRuntimeRegistry.ts')).href,
                    HOOK_DISPATCHER_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'hooks', 'execution', 'dispatchPluginHookEvent.ts')).href,
                },
            });

            expect(parsed).toMatchObject({
                input: {
                    aggregate: {
                        result: {
                            text: '[sdk:inspect]',
                            meta: { intercepted: true },
                        },
                    },
                },
                context: {
                    aggregate: {
                        result: {
                            prompt: 'base prompt\nPlugin context: enabled',
                            messages: [
                                { role: 'user', content: 'hello' },
                                { role: 'system', content: 'plugin-added-context' },
                            ],
                        },
                    },
                },
            });
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 90_000);

    it('keeps lazy plugins inactive until demand and single-flights success and failure activation', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-lazy-home-'));
        const successRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-lazy-success-root-'));
        const failureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-lazy-failure-root-'));
        const testDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-v1-lazy-e2e-'));
        const probeScriptPath = join(testDir, 'plugin-sdk-v1-lazy-probe.mts');
        const activationLogPath = join(testDir, 'activation.log');

        try {
            const successPluginId = 'acme.sdk.lazy.success';
            const successToolId = 'acme.sdk.lazy.success.tool';
            const failurePluginId = 'acme.sdk.lazy.failure';
            const failureActionId = 'acme.sdk.lazy.failure.action';
            await writePluginSdkV1Fixture({
                pluginRoot: successRoot,
                manifest: createPluginSdkV1Manifest({
                    pluginId: successPluginId,
                    uses: ['tools'],
                    permissions: [],
                    activationEvents: [`onTool:${successToolId}`],
                    contributes: {
                        tools: [
                            {
                                id: successToolId,
                                name: 'acme_sdk_lazy_success_tool',
                                title: 'Lazy Success Tool',
                                safety: 'safe',
                                surfaces: ['cli'],
                                handler: { target: 'daemon', registrationId: successToolId },
                            },
                        ],
                    },
                }),
                daemonModuleContents: [
                    'import { appendFile } from "node:fs/promises";',
                    `const marker = ${JSON.stringify(activationLogPath)};`,
                    'export async function activate(host) {',
                    '  await appendFile(marker, "success-activate\\n", "utf8");',
                    `  host.registerTool({ id: ${JSON.stringify(successToolId)}, handler: async () => ({ ok: true, data: { activated: true } }) });`,
                    '}',
                    '',
                ].join('\n'),
            });
            await writeEnabledPluginSdkV1State({
                happyHomeDir,
                pluginRoot: successRoot,
                pluginId: successPluginId,
            });

            await writePluginSdkV1Fixture({
                pluginRoot: failureRoot,
                manifest: createPluginSdkV1Manifest({
                    pluginId: failurePluginId,
                    uses: ['actions'],
                    permissions: [],
                    activationEvents: [`onAction:${failureActionId}`],
                    contributes: {
                        actions: [
                            {
                                id: failureActionId,
                                title: 'Lazy Failure Action',
                                scopes: ['global'],
                                surfaces: ['cli'],
                                placement: 'commandPalette',
                                handler: { target: 'daemon', registrationId: failureActionId },
                                dangerLevel: 'safe',
                            },
                        ],
                    },
                }),
                daemonModuleContents: [
                    'import { appendFile } from "node:fs/promises";',
                    `const marker = ${JSON.stringify(activationLogPath)};`,
                    'export async function activate() {',
                    '  await appendFile(marker, "failure-activate\\n", "utf8");',
                    '  throw new Error("lazy activation exploded");',
                    '}',
                    '',
                ].join('\n'),
            });
            await writeEnabledPluginSdkV1State({
                happyHomeDir,
                pluginRoot: failureRoot,
                pluginId: failurePluginId,
            });

            await writeFile(
                probeScriptPath,
                [
                    'const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
                    'const successPluginId = process.env.SUCCESS_PLUGIN_ID;',
                    'const successToolId = process.env.SUCCESS_TOOL_ID;',
                    'const failurePluginId = process.env.FAILURE_PLUGIN_ID;',
                    'const failureActionId = process.env.FAILURE_ACTION_ID;',
                    'const runtimeRegistryUrl = process.env.RUNTIME_REGISTRY_URL;',
                    'const actionExecutorUrl = process.env.ACTION_EXECUTOR_URL;',
                    'if (!happyHomeDir || !successPluginId || !successToolId || !failurePluginId || !failureActionId || !runtimeRegistryUrl || !actionExecutorUrl) throw new Error("missing probe env");',
                    'const { resolveExecutablePluginRuntimeRegistry } = await import(runtimeRegistryUrl);',
                    'const { executePluginActionIfAvailable } = await import(actionExecutorUrl);',
                    'const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });',
                    'const successActivatedAtStartup = runtimeRegistry.activatedPluginIds.has(successPluginId);',
                    'const failureActivatedAtStartup = runtimeRegistry.activatedPluginIds.has(failurePluginId);',
                    'const projectedTool = runtimeRegistry.contributes.toolsById?.has(successToolId) === true;',
                    'const [successOne, successTwo] = await Promise.all([',
                    '  executePluginActionIfAvailable({ runtimeRegistry, actionId: successToolId, input: {}, context: { surface: "cli" } }),',
                    '  executePluginActionIfAvailable({ runtimeRegistry, actionId: successToolId, input: {}, context: { surface: "cli" } }),',
                    ']);',
                    'const [failureOne, failureTwo] = await Promise.all([',
                    '  executePluginActionIfAvailable({ runtimeRegistry, actionId: failureActionId, input: {}, context: { surface: "cli" } }),',
                    '  executePluginActionIfAvailable({ runtimeRegistry, actionId: failureActionId, input: {}, context: { surface: "cli" } }),',
                    ']);',
                    'await runtimeRegistry.dispose({ timeoutMs: 2000 });',
                    'process.stdout.write(JSON.stringify({ successActivatedAtStartup, failureActivatedAtStartup, projectedTool, successActivatedAfterDemand: runtimeRegistry.activatedPluginIds.has(successPluginId), failureActivatedAfterDemand: runtimeRegistry.activatedPluginIds.has(failurePluginId), successOne, successTwo, failureOne, failureTwo }));',
                    '',
                ].join('\n'),
                'utf8',
            );

            const parsed = runCliSourceProbe({
                scriptPath: probeScriptPath,
                env: {
                    HAPPIER_HOME_DIR: happyHomeDir,
                    SUCCESS_PLUGIN_ID: successPluginId,
                    SUCCESS_TOOL_ID: successToolId,
                    FAILURE_PLUGIN_ID: failurePluginId,
                    FAILURE_ACTION_ID: failureActionId,
                    RUNTIME_REGISTRY_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'runtime', 'resolveExecutablePluginRuntimeRegistry.ts')).href,
                    ACTION_EXECUTOR_URL: pathToFileURL(join(repoRootDir(), 'apps', 'cli', 'src', 'plugins', 'projection', 'actions', 'execute.ts')).href,
                },
            });

            expect(parsed).toMatchObject({
                successActivatedAtStartup: false,
                failureActivatedAtStartup: false,
                projectedTool: true,
                successActivatedAfterDemand: true,
                failureActivatedAfterDemand: false,
                successOne: { matched: true, result: { ok: true, result: { activated: true } } },
                successTwo: { matched: true, result: { ok: true, result: { activated: true } } },
                failureOne: { matched: true, result: { ok: false, errorCode: 'plugin_activation_failed' } },
                failureTwo: { matched: true, result: { ok: false, errorCode: 'plugin_activation_failed' } },
            });
            expect(await readFile(activationLogPath, 'utf8')).toBe('success-activate\nfailure-activate\n');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(successRoot, { recursive: true, force: true });
            await rm(failureRoot, { recursive: true, force: true });
            await rm(testDir, { recursive: true, force: true });
        }
    }, 120_000);
});
