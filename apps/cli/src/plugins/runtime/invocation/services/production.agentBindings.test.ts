import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as nativeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { readBundledPluginManifest } from '@/plugins/projection/registry/builtIn/manifestFile';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { resolveManifestHostAccessRequestsForQualifiedContribution } from '@/plugins/runtime/hostAccess/manifestRequests';

import { createProductionPluginInvocationServiceOwners } from './production';
import { createUnavailablePluginInvocationServiceBinding } from './factory';
import { createStablePluginHttpHost } from '../../fetch/service';
import { assemblePluginRuntimeConsumers } from '../../composition/consumerAssembly';
import { activatePluginRuntimeRegistry } from '../../lifecycle/manager';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

const agents = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.flatMap((locator) => {
    const manifest = readCanonicalPluginManifest(readBundledPluginManifest(locator));
    if (!manifest) throw new Error(`Invalid bundled manifest: ${locator.pluginId}`);
    return manifest.contributes.agents.map((agent) => ({
        pluginId: manifest.id,
        version: manifest.version,
        agentId: agent.id,
        manifest,
    }));
});

describe('first-party Agent invocation service composition', () => {
    it.each(['retirement', 'caller', 'disposal'] as const)(
        'settles an admitted filesystem read at its natural boundary on %s and refuses successor admission',
        async reason => {
            const root = await mkdtemp(join(tmpdir(), 'happier-finite-fs-'));
            const registry = await activatePluginRuntimeRegistry({
                contributes: createResolvedContributionRegistry({}), generation: 1,
            });
            const consumers = assemblePluginRuntimeConsumers({ activatedRegistry: registry,
                onFencePlugin() {}, async retirePluginDatabases() {} });
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write() {} },
                resolveRetirementSignal: pluginId => consumers.resolveLifecycle(pluginId).retirementSignal,
            });
            const caller = new AbortController();
            let entered!: () => void;
            const reading = new Promise<void>(resolve => { entered = resolve; });
            let release!: () => void;
            const released = new Promise<void>(resolve => { release = resolve; });
            const open = nativeFs.open;
            // The actual native file read is the only deferred boundary. Service
            // construction, lifecycle, path resolution and file contents stay real.
            const opening = vi.spyOn(nativeFs, 'open').mockImplementation(async (...args) => {
                const handle = await open(...args);
                const read = handle.readFile.bind(handle);
                vi.spyOn(handle, 'readFile').mockImplementation(async () => {
                    entered();
                    await released;
                    return await read();
                });
                return handle;
            });
            let pending: Promise<Uint8Array> | undefined;
            try {
                await writeFile(join(root, 'ready.txt'), 'ready');
                const pluginId = 'acme.finite-fs';
                const signal = consumers.composeSignal(pluginId, caller.signal);
                const service = owners.createOperationServices({
                    plugin: { id: pluginId, version: '1' },
                    contribution: { id: 'read', qualifiedId: `${pluginId}/actions/read` },
                    occurrenceId: 'finite-fs', correlationId: 'finite-fs', surface: 'cli', signal,
                    isOccurrenceCurrent: () => consumers.isPluginCurrent(pluginId),
                }, { filesystemRoots: { pluginData: root, workspace: root, projects: new Map() }, hostAccessRequests: [] }).fs;
                const path = { root: 'workspace' as const, relativePath: 'ready.txt' };
                pending = service.readFile(path);
                await reading;
                const result = reason === 'retirement'
                    ? expect(pending).resolves.toEqual(new TextEncoder().encode('ready'))
                    : expect(pending).rejects.toBeDefined();
                if (reason === 'retirement') consumers.fencePlugins([pluginId]);
                else if (reason === 'caller') caller.abort();
                else consumers.dispose('test shutdown');
                release();
                await result;
                await expect(service.readFile(path)).rejects.toMatchObject({
                    code: reason === 'caller' ? 'plugin_fs_aborted' : 'plugin_generation_stale',
                });
            } finally {
                release();
                await pending?.catch(() => undefined);
                opening.mockRestore();
                consumers.dispose('test shutdown');
                await owners.dispose();
                await registry.dispose();
                await rm(root, { recursive: true, force: true });
            }
        },
    );
    it('reads a selected workspace symlink without using manifest scopes as a sandbox', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-trusted-plugin-workspace-'));
        const source = await mkdtemp(join(tmpdir(), 'happier-trusted-plugin-source-'));
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        try {
            await writeFile(join(source, 'ready.txt'), 'ready');
            await symlink(source, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
            const services = owners.createOperationServices({
                plugin: { id: 'test.services', version: '1.0.0' },
                contribution: { id: 'read', qualifiedId: 'test.services/actions/read' },
                occurrenceId: 'workspace-link', correlationId: 'workspace-link', surface: 'agent',
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            }, { filesystemRoots: { pluginData: workspace, workspace, projects: new Map() }, hostAccessRequests: [] });
            await expect(services.fs.readFile({ root: 'workspace', relativePath: 'linked/ready.txt' }))
                .resolves.toEqual(new TextEncoder().encode('ready'));
        } finally {
            await owners.dispose();
            await rm(workspace, { recursive: true, force: true });
            await rm(source, { recursive: true, force: true });
        }
    });
    it('constructs actual services once and reports a missing host service without throwing', async () => {
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        try {
            const services = owners.createServices({
                plugin: { id: 'test.services', version: '1.0.0' },
                contribution: { id: 'read', qualifiedId: 'test.services/actions/read' },
                occurrenceId: 'actual-services', correlationId: 'actual-services', surface: 'agent',
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            }, createUnavailablePluginInvocationServiceBinding('actual-services', 'actual-services'));
            expect(services.availability('logger')).toEqual({ status: 'available' });
            expect(services.availability('http')).toEqual({ status: 'unavailable', code: 'plugin_service_unavailable' });
            expect(() => services.http.request({ url: 'https://example.com', redirect: 'error' })).toThrowError(
                expect.objectContaining({ code: 'plugin_service_unavailable' }),
            );
        } finally { await owners.dispose(); }
    });

    it('allows an undeclared host through the production HTTP composition', async () => {
        // The HTTP transport is the external boundary; policy and composition stay real.
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            http: createStablePluginHttpHost({ adapter: {
                async request(request) { return { status: 200, headers: {}, body: new TextEncoder().encode('ready'), finalUrl: request.url }; },
                async openWebSocket() { throw new Error('Not exercised'); },
            } }),
        });
        try {
            const services = owners.createServices({
                plugin: { id: 'test.services', version: '1.0.0' },
                contribution: { id: 'read', qualifiedId: 'test.services/actions/read' },
                occurrenceId: 'undeclared-host', correlationId: 'undeclared-host', surface: 'agent',
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            }, owners.createOrdinaryServiceBinding('undeclared-host', 'undeclared-host'));
            await expect(services.http.request({ url: 'https://undeclared.example/resource', redirect: 'follow' }))
                .resolves.toMatchObject({ status: 200, body: new TextEncoder().encode('ready') });
        } finally { await owners.dispose(); }
    });
    it.each(agents)('constructs declared services for $pluginId/$agentId before native Session open', async ({
        pluginId, version, agentId, manifest,
    }) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-agent-service-binding-'));
        const controller = new AbortController();
        const records: string[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record.message ?? ''); } },
            exec: {
                resolveExecutable: async () => { throw new Error('Service construction must not launch a native process'); },
                resolvePath: async () => { throw new Error('Operation roots own path resolution'); },
            },
        });
        try {
            await writeFile(join(root, 'ready.txt'), 'ready');
            const contribution = { id: agentId, qualifiedId: `${pluginId}/agents/${agentId}` };
            const hostAccessRequests = resolveManifestHostAccessRequestsForQualifiedContribution({
                manifest, pluginId, contribution,
            });
            if (!hostAccessRequests) throw new Error(`Missing Agent declaration: ${contribution.qualifiedId}`);
            const services = owners.createOperationServices({
                plugin: { id: pluginId, version },
                contribution,
                occurrenceId: 'agent-service-binding',
                correlationId: 'first-session-open',
                surface: 'agent',
                session: { id: 'session-service-binding' },
                signal: controller.signal,
                isOccurrenceCurrent: () => !controller.signal.aborted,
            }, {
                filesystemRoots: { pluginData: root, workspace: root, projects: new Map() },
                environment: {},
                hostAccessRequests,
            });
            services.logger.info('Agent service construction completed');
            expect(records).toContain('Agent service construction completed');
            expect(services.availability('logger')).toEqual({ status: 'available' });
            expect(services.availability('events')).toEqual({ status: 'available' });
            expect(services.availability('exec')).toEqual({ status: 'available' });
            await expect(services.fs.readFile({ root: 'pluginData', relativePath: 'ready.txt' }))
                .resolves.toEqual(new TextEncoder().encode('ready'));
        } finally {
            controller.abort();
            await owners.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
});
