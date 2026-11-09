import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createLanguageServerHost } from './languageServerHost';
import { createLanguageServerInitializationOptionsReader, createLanguageServerProtocolOpener } from './managedProtocol';

describe('external SDK-authored managed JavaScript language server', () => {
    it('uses installed declarations, settings custody and real RPC/process ownership', async () => {
        await withTempDir('happier-lsp-managed-js-', async rootPath => {
            vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
            const pluginId = 'fixture.managed-language';
            const pluginRoot = join(rootPath, 'plugin');
            const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
            const logPath = join(rootPath, 'messages.jsonl');
            const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Fixture language', runtime: { apiVersion: 1 },
                managedDependencies: { server: { title: 'Fixture server', executable: 'fixture-language', sources: [{
                    kind: 'managedJavaScriptPackage', installId: 'dep.fixture.managed-language', packageName: '@fixture/language', version: '1.0.0',
                }] } },
                languageServers: { fixture: { title: 'Fixture', languageIds: { fixture: 'fixture' },
                    executable: { kind: 'managedDependency', id: 'server' }, args: [logPath],
                    initializationOptionsSetting: { scope: 'daemon', field: 'options' } } },
                settings: { configuration: { title: 'Language server', target: { kind: 'plugin' }, scope: 'daemon', fields: [{
                    id: 'options', title: 'Server options', schema: { type: 'object', additionalProperties: false,
                        properties: { handledSchemaProtocols: { type: 'array', items: { type: 'string', enum: ['file', 'https'] } } },
                        required: ['handledSchemaProtocols'] }, default: { handledSchemaProtocols: ['file'] },
                }] } },
            });
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(plugin.manifest));
            await writeFile(logPath, '');
            await writeFile(join(rootPath, 'sample.fixture'), 'hello');
            const installed = PluginStateFileV1Schema.parse({ t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: { [pluginId]: {
                source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
                compatibility: { status: 'compatible', diagnostics: [] },
                install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
            } } }).plugins[pluginId];
            if (!installed) throw new Error('Installed fixture is missing');
            await writeCommittedLocalPathPluginFixture({ happyHomeDir: rootPath, pluginId, sourceRootPath: pluginRoot, plugin: installed });
            // The test home is owned by the package testkit; no user installation is touched.
            const packageRoot = join(configuration.happyHomeDir, 'tools', 'providers', 'dep.fixture.managed-language', 'current', 'workspace', 'node_modules', '@fixture', 'language');
            await mkdir(packageRoot, { recursive: true });
            await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/language', version: '1.0.0', bin: { 'fixture-language': 'server.cjs' } }));
            await copyFile(resolve('src/lsp/__fixtures__/languageServer.cjs'), join(packageRoot, 'server.cjs'));
            const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: rootPath, pluginIds: [pluginId] });
            const reload = createPluginReloadController({ resolveRuntimeRegistry: async () => registry });
            const acquireRuntimeRegistry = () => reload.acquireRuntimeRegistry();
            const host = createLanguageServerHost({ readCurrentContributionRegistry: () => registry.contributes,
                openProtocol: createLanguageServerProtocolOpener({ acquireRuntimeRegistry }),
                readInitializationOptions: createLanguageServerInitializationOptionsReader({ acquireRuntimeRegistry }) });
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
            registerLanguageIntelligenceHandlers(registrar, rootPath, { host, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
            const call = async (method: string, input: unknown) => {
                const handler = handlers.get(method);
                if (!handler) throw new Error(`Missing production handler ${method}`);
                return handler(input);
            };
            const query = () => call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'sample.fixture', languageId: 'fixture',
                kind: 'hover', position: { line: 0, character: 0 } });
            const initializations = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean)
                .map(line => JSON.parse(line) as { method?: string; params?: unknown }).filter(message => message.method === 'initialize');
            try {
                expect(registry.contributes.managedDependencies.filter(dependency => dependency.pluginId === pluginId),
                    JSON.stringify({ entrypoints: plugin.manifest.entrypoints, diagnostics: registry.contributes.pluginDiagnosticsByPluginId?.[pluginId] }))
                    .toMatchObject([{ definition: { id: 'server' } }]);
                const ready = await registry.resolveReadyManagedExecutable?.({ kind: 'managedDependency', id: 'server' }, pluginId);
                expect(ready).toMatchObject({ command: process.execPath });
                ready?.release?.();
                const settings = registry.createPluginSettingsService?.({ pluginId, scope: { kind: 'daemon' } });
                if (!settings) throw new Error('Canonical plugin settings service is missing');
                expect(await settings.get('options')).toEqual({ handledSchemaProtocols: ['file'] });
                expect(registry.activatedPluginIds.has(pluginId)).toBe(false);
                await call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'open', path: 'sample.fixture', languageId: 'fixture', text: 'hello', version: 1, unsaved: false } });
                const response = await query();
                expect(response, JSON.stringify({ response, state: await host.watch({ rootPath }) })).toMatchObject({ status: 'ok', sections: [{ markdown: 'hello' }] });
                expect(await initializations()).toMatchObject([{ params: { initializationOptions: { handledSchemaProtocols: ['file'] } } }]);
                await settings.set('options', { handledSchemaProtocols: ['file', 'https'] });
                await call(RPC_METHODS.DAEMON_LSP_RESTART, { rootPath });
                expect(await query()).toMatchObject({ status: 'ok' });
                expect(await initializations()).toMatchObject([
                    { params: { initializationOptions: { handledSchemaProtocols: ['file'] } } },
                    { params: { initializationOptions: { handledSchemaProtocols: ['file', 'https'] } } },
                ]);
                expect(registry.activatedPluginIds.has(pluginId)).toBe(false);
            } finally { await host.dispose(); await reload.shutdown(); vi.unstubAllEnvs(); }
        });
    });
});
