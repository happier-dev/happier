import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPluginInvocationServiceBinding } from '../../invocation/services/unavailable';
import { createBackgroundServiceProcessServices } from './backgroundServiceProcessServices';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { createStablePluginHttpHost } from '../../fetch/service';
import type { PluginInvocationLogRecord } from '../../invocation/services/logger';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude';
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex';
import { createBackgroundServiceProcessServiceClient, createBackgroundServiceProcessServiceHost, type BackgroundServiceProcessBridgeMessage } from './backgroundServiceProcessBridge';

describe('background process invocation services', () => {
    it('releases completed native operation capabilities instead of retaining the indexed corpus in the daemon', async () => {
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const roots = { prepare: (signal: AbortSignal) => parent.prepareBackgroundServiceProcessOperationServices({
            plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'reader', qualifiedId: 'fixture/agents/reader' },
            occurrenceId: 'occurrence', correlationId: 'reader', surface: 'agent', signal,
            isOccurrenceCurrent: () => !signal.aborted,
        }, { hostAccessRequests: [], filesystemRoots: { pluginData: '/tmp/unused-plugin-data', workspace: '/tmp/unused-workspace', projects: new Map() } }) };
        let client: ReturnType<typeof createBackgroundServiceProcessServiceClient<typeof roots>>;
        const copy = (message: BackgroundServiceProcessBridgeMessage) => JSON.parse(JSON.stringify(message));
        const host = createBackgroundServiceProcessServiceHost({ services: roots, send: message => queueMicrotask(() => client.receive(copy(message))) });
        client = createBackgroundServiceProcessServiceClient<typeof roots>({ description: JSON.parse(JSON.stringify(host.description)), send: message => queueMicrotask(() => host.receive(copy(message))) });
        const completed: Awaited<ReturnType<typeof roots.prepare>>[] = [];
        try {
            for (let index = 0; index < 100; index += 1) {
                const controller = new AbortController();
                const prepared = await client.services.prepare(controller.signal);
                await prepared.services.__backgroundServiceProcessLocal.writeLog({ level: 'info', message: 'owned operation' });
                controller.abort();
                await prepared.dispose();
                completed.push(prepared);
            }
            const retained = await Promise.allSettled(completed.map(prepared => prepared.services.__backgroundServiceProcessLocal.writeLog({ level: 'info', message: 'retired operation' })));
            expect(retained.filter(result => result.status === 'fulfilled')).toHaveLength(0);
            expect(retained.every(result => result.status === 'rejected' && result.reason instanceof PluginError
                && result.reason.code === 'background_service_process_method_unavailable')).toBe(true);
        } finally { await client.dispose(); await host.dispose(); await parent.dispose(); }
    });

    it.each([CLAUDE_PLUGIN_MANIFEST, CODEX_PLUGIN_MANIFEST])('binds a native reader without requiring unrelated Agent runtime services ($id)', async manifest => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-process-native-admission-'));
        await writeFile(join(directory, 'native-transcript'), 'owned native fixture');
        const parsed = ingestPluginManifestV2(manifest);
        if (!parsed.ok) throw new Error('Expected the real bundled Agent manifest to be valid');
        const controller = new AbortController();
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const plugin = { id: parsed.manifest.id, version: parsed.manifest.version };
        const localId = parsed.manifest.contributes.agents[0]!.id;
        const contribution = { id: localId, qualifiedId: `${plugin.id}/agents/${localId}` };
        const roots = { prepare: () => parent.prepareBackgroundServiceProcessOperationServices({
            plugin, contribution, occurrenceId: 'occurrence', correlationId: 'reader', surface: 'agent',
            signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
        }, {
            filesystemRoots: { pluginData: directory, workspace: directory, projects: new Map() },
            hostAccessRequests: parsed.manifest.hostAccess.required.map(request => ({ required: true, request })),
        }) };
        let client: ReturnType<typeof createBackgroundServiceProcessServiceClient<typeof roots>>;
        const copy = (message: BackgroundServiceProcessBridgeMessage) => JSON.parse(JSON.stringify(message));
        const host = createBackgroundServiceProcessServiceHost({ services: roots, send: message => queueMicrotask(() => client.receive(copy(message))) });
        client = createBackgroundServiceProcessServiceClient<typeof roots>({ description: JSON.parse(JSON.stringify(host.description)), send: message => queueMicrotask(() => host.receive(copy(message))) });
        try {
            const prepared = await client.services.prepare();
            const child = createBackgroundServiceProcessServices({ metadata: { plugin, contribution }, signal: controller.signal,
                localPolicy: prepared.localPolicy, clientServices: prepared.services });
            try {
                expect(Buffer.from(await child.services.fs.readFile({ root: 'workspace', relativePath: 'native-transcript' })).toString()).toBe('owned native fixture');
                expect(child.services.availability('managedServices').status).toBe('unavailable');
                expect(child.services.availability('http').status).not.toBe('available');
            } finally { await child.dispose(); }
        } finally {
            controller.abort(); await client.dispose(); await host.dispose(); await parent.dispose();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('applies the daemon invocation redactor to child-local logger records', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const controller = new AbortController();
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write: (record) => records.push(record) } });
        const seed = { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' },
            occurrenceId: 'occurrence', correlationId: 'redaction', surface: 'background' as const, signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted };
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        parent.beginDiagnosticScope({ pluginId: 'fixture', occurrenceId: 'occurrence', correlationId: 'redaction' }, controller.signal, {}, []);
        parent.registerRawForRedaction(seed, 'opaque-credential-value');
        const longCredential = `opaque-native-${'abcXYZ'.repeat(1000)}`;
        parent.registerRawForRedaction(seed, longCredential);
        try {
            const prepared = await parent.prepareBackgroundServiceProcessLocalPolicy(seed, { ...binding, availability: { ...binding.availability, logger: 'available' } });
            const child = createBackgroundServiceProcessServices({ metadata: { plugin: seed.plugin, contribution: seed.contribution }, signal: controller.signal, clientServices: prepared.services, localPolicy: prepared.localPolicy });
            try {
                child.services.logger.info('result opaque-credential-value', { content: 'opaque-credential-value' });
                expect(records).toHaveLength(1);
                expect(JSON.stringify(records)).not.toContain('opaque-credential-value');
                expect(records[0]!.context.correlationId).toBe('redaction');
                child.services.logger.info(`result ${longCredential}`, { content: longCredential });
                expect(records).toHaveLength(2);
                expect(JSON.stringify(records)).not.toContain(longCredential.slice(0, 100));
            } finally { await child.dispose(); }
        } finally { controller.abort(); await parent.dispose(); }
    });

    it('uses the native reader operation roots and policy through the same services owner', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-process-native-services-'));
        await writeFile(join(directory, 'native-transcript'), 'native reader');
        const controller = new AbortController();
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, filesystemRoots: { pluginData: '/not-the-native-root', workspace: '/not-the-native-root', projects: new Map() } });
        try {
            const prepared = await parent.prepareBackgroundServiceProcessOperationServices({
                plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'native-reader', qualifiedId: 'fixture/agents/native-reader' },
                occurrenceId: 'occurrence', correlationId: 'reader', surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            }, {
                filesystemRoots: { pluginData: directory, workspace: directory, projects: new Map() },
                hostAccessRequests: [{ required: true, request: { id: 'native-files', capability: 'filesystem', reason: 'Read native transcripts', scope: { locations: [{ root: 'workspace' }], access: ['read'] } } }],
            });
            const child = createBackgroundServiceProcessServices({ metadata: { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'native-reader', qualifiedId: 'fixture/agents/native-reader' } },
                signal: controller.signal, localPolicy: prepared.localPolicy, clientServices: prepared.services });
            try {
                expect(Buffer.from(await child.services.fs.readFile({ root: 'workspace', relativePath: 'native-transcript' })).toString()).toBe('native reader');
            } finally { await child.dispose(); }
        } finally { controller.abort(); await parent.dispose(); await rm(directory, { force: true, recursive: true }); }
    });

    it('resolves system tools through the admitted owner and executes with child-local custody', async () => {
        const controller = new AbortController();
        const executable = { kind: 'systemTool' as const, id: 'fixture-tool' };
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolveExecutable: async () => { throw new Error('System tool must use its selected grant'); },
            resolvePath: async () => { throw new Error('No cwd requested'); },
            systemToolsForPlugin: () => ({ resolve: async () => ({
                grantId: 'fixture', toolId: 'fixture-tool', displayName: 'Fixture', source: 'managed' as const,
                executablePath: process.execPath, launch: { kind: 'binary' as const, executablePath: process.execPath },
            }) }),
        } });
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        try {
            const prepared = await parent.prepareBackgroundServiceProcessLocalPolicy({
                plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' },
                occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            }, { ...binding, availability: { ...binding.availability, logger: 'available', exec: 'available' }, processExecutables: [executable] });
            const child = createBackgroundServiceProcessServices({
                metadata: { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' } },
                signal: controller.signal, localPolicy: prepared.localPolicy, clientServices: prepared.services,
            });
            try {
                const resolved = await child.services.exec.systemTools.resolve({ toolId: 'fixture-tool', purpose: 'Read fixture process identity' });
                const result = await child.services.exec.run({ executable: resolved.executable, args: ['-e', 'process.stdout.write("child-local")'] });
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                expect(Buffer.from(result.stdout).toString()).toBe('child-local');
            } finally { await child.dispose(); }
        } finally { controller.abort(); await parent.dispose(); }
    });

    it('prepares admitted local policy through the existing production owner and preserves daemon HTTP policy', async () => {
        const controller = new AbortController();
        let revalidated = false;
        const host = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            filesystemRoots: { pluginData: '/tmp/plugin', workspace: '/tmp/workspace', projects: new Map() },
            http: createStablePluginHttpHost({
                adapter: { request: async () => { throw new Error('daemon performed HTTP I/O'); }, openWebSocket: async () => { throw new Error('not requested'); } },
            }),
        });
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        try {
            const prepared = await host.prepareBackgroundServiceProcessLocalPolicy({
                plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' },
                occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            }, binding);
            expect(prepared.localPolicy.filesystemRoots?.workspace).toBe('/tmp/workspace');
            const response = await prepared.services.__backgroundServiceProcessLocal.http!.request({ url: 'https://example.test/data', redirect: 'error' }, {}, {
                request: async () => ({ status: 200, finalUrl: 'https://example.test/data', headers: {}, body: new Uint8Array([1]) }),
                openWebSocket: async () => { throw new Error('not requested'); },
            });
            expect(response.body).toEqual(new Uint8Array([1]));
        } finally { controller.abort(); await host.dispose(); }
    });

    it('fails closed without availability evidence while preserving explicitly bound private roots', async () => {
        const owner = createBackgroundServiceProcessServices({ metadata: {}, signal: new AbortController().signal,
            clientServices: { storage: { daemon: { get: async () => 'bypassed' } }, memory: { read: async () => 7 } },
        });
        expect(owner.services.availability('storage').status).toBe('unavailable');
        expect(() => owner.services.storage.daemon.get('key')).toThrow();
        expect(owner.services.memory).toMatchObject({ read: expect.any(Function) });
        expect(owner.services.availability('notifications').status).toBe('unavailable');
        await owner.dispose();
    });

    it('uses canonical filesystem policy and retires local operations when the child run settles', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-process-services-'));
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        const owner = createBackgroundServiceProcessServices({
            metadata: { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' } },
            signal: new AbortController().signal, clientServices: { __backgroundServiceProcessLocal: { async writeLog() {} } },
            localPolicy: { binding,
                filesystemRoots: { pluginData: directory, workspace: directory, projects: [] },
            },
        });
        try {
            expect(owner.services.availability('fs').status).toBe('available');
            await owner.services.fs.writeFile({ root: 'pluginData', relativePath: 'row' }, new Uint8Array([1, 2]));
            expect(await owner.services.fs.readFile({ root: 'pluginData', relativePath: 'row' })).toEqual(new Uint8Array([1, 2]));
            await expect(owner.services.fs.readFile({ root: 'pluginData', relativePath: '../outside' })).rejects.toThrow();
            await owner.dispose();
            await expect(owner.services.fs.readFile({ root: 'pluginData', relativePath: 'row' })).rejects.toThrow();
        } finally { await owner.dispose(); await rm(directory, { force: true, recursive: true }); }
    });
});
