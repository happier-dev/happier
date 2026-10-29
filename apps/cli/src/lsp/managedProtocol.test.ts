import { describe, expect, it, vi } from 'vitest';
import { basename, resolve, join } from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { isPidAlive } from '@/testkit/process/spawn';
import { createLanguageServerProtocolOpener } from './managedProtocol';
import { createLanguageServerProjectChecker } from './projectCheck';
import { createLanguageServerDefinitions } from './languageServerDefinitions';
import { createLanguageServerHost } from './languageServerHost';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';

describe('managed language server protocol', () => {
    it.each(['protocol', 'retirement', 'host-disable', 'host-replacement', 'project-check', 'project-check-retirement'] as const)('launches an installed declaration through its %s lifecycle', async scenario => {
        await withTempDir('happier-lsp-managed-', async rootPath => {
            const pluginId = 'fixture.language';
            const pluginRoot = join(rootPath, 'plugin');
            const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
            const logPath = join(rootPath, 'process.json');
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Fixture',
                runtime: { apiVersion: 1 }, contributes: {
                    languageServers: [{ id: 'language', title: 'Fixture', languageIds: { fixture: 'fixture' },
                        ...(scenario.startsWith('project-check') ? { projectCheck: { executable: { kind: 'systemTool', id: 'native' },
                            args: [resolve('src/lsp/__fixtures__/projectCheck.cjs'), scenario === 'project-check' ? 'diagnostics' : 'wait', logPath],
                            projectFile: 'tsconfig.json', output: { kind: 'typescript' } } } : {}),
                        executable: { kind: 'systemTool', id: 'native' }, args: scenario.startsWith('host-')
                            ? [resolve('src/lsp/__fixtures__/languageServer.cjs'), logPath, JSON.stringify({ delayHover: true })]
                            : [resolve('src/lsp/__fixtures__/managedProtocol.cjs'), logPath] }],
                    systemTools: [{ id: 'native', title: 'Fixture native executable', executableNames: [basename(process.execPath)] }],
                },
            }));
            const happyHomeDir = join(rootPath, 'home');
            const installed = PluginStateFileV1Schema.parse({
                t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: { [pluginId]: {
                    source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
                    compatibility: { status: 'compatible', diagnostics: [] },
                    install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
                } },
            }).plugins[pluginId];
            if (!installed) throw new Error('Installed fixture record is absent');
            await writeCommittedLocalPathPluginFixture({ happyHomeDir, pluginId, sourceRootPath: pluginRoot, plugin: installed });
            const registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir, pluginIds: [pluginId],
            });
            const controller = createPluginReloadController({ resolveRuntimeRegistry: async () => registry });
            const openProtocol = createLanguageServerProtocolOpener({ acquireRuntimeRegistry: () => controller.acquireRuntimeRegistry() });
            const definition = createLanguageServerDefinitions({ readCurrentContributionRegistry: () => registry.contributes })
                .readLanguageServerDefinitions().find(candidate => candidate.pluginId === pluginId);
            if (!definition) throw new Error('Installed language-server definition was not projected');
            if (scenario.startsWith('project-check')) {
                const checker = createLanguageServerProjectChecker({ acquireRuntimeRegistry: () => controller.acquireRuntimeRegistry() });
                try {
                    const pending = checker.run({ definition, rootPath,
                        processOwner: { kind: 'service', serviceId: `lsp:${definition.id}:123456789abc` }, signal: new AbortController().signal });
                    if (scenario === 'project-check') {
                        expect(await pending).toMatchObject({ status: 'completed', diagnostics: [
                                { serverId: definition.id, path: 'src/a(b).ts', code: 'TS2322' },
                                { path: 'tsconfig.json', code: 'TS18003' },
                            ] });
                    } else {
                        await vi.waitFor(async () => expect(await readFile(logPath, 'utf8')).toBe('ready'));
                        const pid = checker.readProcessRoots()[0].pid;
                        await registry.retirePluginConsumers?.([pluginId]);
                        expect(await pending).toMatchObject({ status: 'cancelled' });
                        expect(isPidAlive(pid)).toBe(false);
                        expect(checker.readProcessRoots()).toEqual([]);
                    }
                } finally { await controller.shutdown(); }
                return;
            }
            if (scenario.startsWith('host-')) {
                const handles: PluginProtocolClientHandle<'jsonRpc'>[] = [];
                const host = createLanguageServerHost({
                    readCurrentContributionRegistry: () => controller.getState().activeRegistry?.contributes ?? registry.contributes,
                    async openProtocol(input) { const handle = await openProtocol(input); handles.push(handle); return handle; },
                });
                try {
                    await writeFile(join(rootPath, 'a.ts'), 'broken');
                    expect(await host.sync({ rootPath, op: { op: 'open', path: 'a.ts', languageId: 'fixture', text: 'broken', version: 1, unsaved: false } }))
                        .toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
                    expect(await host.query({ rootPath, path: 'a.ts', kind: 'diagnostics' }))
                        .toMatchObject({ status: 'ok', diagnostics: [{ message: 'broken' }] });
                    const pending = host.query({ rootPath, path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                    await vi.waitFor(async () => expect((await readFile(logPath, 'utf8')).includes('textDocument/hover')).toBe(true));
                    if (scenario === 'host-replacement') {
                        const next = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, pluginIds: [pluginId] });
                        await controller.adoptPreparedRuntimeRegistry({ registry: next, changedPluginIds: [pluginId], runningSessionDisposition: 'retainRunningSessions' });
                    } else await registry.retirePluginConsumers?.([pluginId]);
                    // Retirement must initiate the stop itself; only after root
                    // exit do we join the supervisor's native subtree cleanup.
                    await handles[0].wait();
                    await handles[0].dispose();
                    await vi.waitFor(async () => expect(await host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [] }));
                    expect(await pending).not.toMatchObject({ status: 'ok' });
                    expect(await host.watch({ rootPath })).toMatchObject({ status: 'ok', diagnostics: { 'a.ts': { [definition.id]: { items: [] } } } });
                    if (scenario === 'host-replacement') {
                        expect(await host.query({ rootPath, path: 'a.ts', languageId: 'fixture', kind: 'diagnostics', text: 'disk' }))
                            .toMatchObject({ status: 'ok', diagnostics: [{ message: 'broken' }] });
                        expect(handles).toHaveLength(2);
                    }
                } finally { await host.dispose(); await controller.shutdown(); }
                return;
            }
            const processOwner = { kind: 'service', serviceId: `lsp:${definition.id}:123456789abc` } as const;
            const handle = await openProtocol({
                definition,
                rootPath, processOwner, signal: new AbortController().signal,
            });
            const pid = readSupervisedPluginProcessIdForHost(handle.process);
            if (pid === null) throw new Error('Language-server process identity is unavailable');
            try {
                expect(await handle.client.request('echo', { value: 'héllo' })).toEqual({ value: 'héllo' });
                const characters = 384 * 1024;
                expect(await handle.client.request('largeReply', { characters })).toEqual({ value: 'x'.repeat(characters) });
                const facts = JSON.parse(await readFile(logPath, 'utf8')) as { cwd: string; owner: string };
                expect(facts.cwd).toBe(await realpath(rootPath));
                expect(parseProcessOwnerTag(facts.owner)?.owner).toEqual(processOwner);
                if (scenario === 'retirement') {
                    const pending = handle.client.request('wait').then(() => 'answered', () => 'retired');
                    await handle.client.request('echo', { barrier: true });
                    await registry.retirePluginConsumers?.([pluginId]);
                    await expect(handle.client.request('echo', { after: true })).rejects.toBeDefined();
                    // Fencing rejects new requests before native cleanup reaches
                    // the root. Observe its exit rather than timing the census.
                    await handle.wait();
                    expect(isPidAlive(pid)).toBe(false);
                    expect(await pending).toBe('retired');
                } else {
                    const characters = 3 * 1024 * 1024;
                    expect(await handle.client.request('largeReply', { characters })).toEqual({ value: 'x'.repeat(characters) });
                    expect(await handle.client.request('echo', { afterLargeReply: true })).toEqual({ afterLargeReply: true });
                }
            } finally { await handle.dispose(); }
            expect((await handle.wait()).termination.observed.kind).not.toBe('failed');
            expect(isPidAlive(pid)).toBe(false);
            await controller.shutdown();
        });
    });
});
