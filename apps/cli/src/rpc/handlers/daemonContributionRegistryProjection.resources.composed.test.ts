import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createMachineLiveStreamCaptureRegistry } from '@/daemon/peer/mediation/stream/captureRegistry';
import { logger } from '@/ui/logger';
import { evaluateManifestPluginDevelopmentCandidate } from '@/plugins/authoring/sourceModule';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

it('keeps declared reads across retained activation replacement and identifies an undeclared ref without its payload', async () => {
    const pluginId = 'acme.resource-continuity';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { resources: [{
            id: 'status', kind: 'asset', path: 'status.txt', contentType: 'text/plain',
        }] } }),
        files: { 'daemon.mjs': 'export function activate() {}', 'status.txt': 'private resource contents' },
    }] });
    let registry = fixture.registry;
    let successor: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    // File logging is an OS boundary; keep the actual RPC, admission and Resource owners.
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const rpc = new RpcHandlerManager({ scopePrefix: 'resource-machine', encryptionMode: 'plain', logger: () => {} });
    registerDaemonContributionRegistryProjectionHandler(rpc, {
        resolveRuntimeRegistry: async () => registry,
        resolveGeneration: async () => registry.generation,
        resolveInstalledPackages: async () => [],
    });
    const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
    if (!occurrenceId) throw new Error('Missing admitted Resource occurrence');
    const read = (localId: string, expectedCallerOccurrenceId = occurrenceId) => rpc.invokeLocal(
        RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, {
            machineId: 'resource-machine', callerPluginId: pluginId, expectedCallerOccurrenceId,
            resource: { pluginId, localId },
        });
    try {
        const original = await read('status');
        expect(original).toMatchObject({ ok: true, bytesBase64: Buffer.from('private resource contents').toString('base64') });
        const component = fixture.registry.retainPluginActivationComponent?.(pluginId);
        if (!component) throw new Error('Missing retained Resource activation');
        successor = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir, contributes: fixture.registry.contributes,
            generationAuthority: fixture.committed, generation: fixture.registry.generation + 1,
            pluginIds: [pluginId], retainedActivationRegistryLeases: [component],
        });
        registry = successor;
        await fixture.registry.dispose();
        expect(await read('status')).toEqual(original);
        expect(await read('status', 'replaced-occurrence')).toMatchObject({
            ok: false, code: 'plugin_occurrence_stale', reason: 'stale_occurrence',
        });
        expect(await read('no-longer-declared')).toMatchObject({
            ok: false, code: 'plugin_resource_not_found', reason: 'not_found',
        });
        const refusals = diagnostics.mock.calls.filter(([message]) => message === '[PLUGIN RESOURCE] Read refused');
        expect(refusals).toContainEqual(['[PLUGIN RESOURCE] Read refused', {
            callerPluginId: pluginId, resourcePluginId: pluginId, resourceId: 'no-longer-declared',
            expectedCallerOccurrenceId: occurrenceId, generation: successor.generation,
            code: 'plugin_resource_not_found', reason: 'not_found',
        }]);
        expect(JSON.stringify(refusals)).not.toContain('private resource contents');
    } finally {
        diagnostics.mockRestore();
        await successor?.dispose();
        await fixture.dispose();
    }
});


it('resolves the named capture producer for another mounted plugin and retains caller and Machine admission', async () => {
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
        manifest: createPluginManifestV2Fixture({ id: 'acme.viewer' }),
        files: { 'daemon.mjs': 'export function activate() {}' },
    }, {
        manifest: createPluginManifestV2Fixture({ id: 'acme.producer', contributes: { captureSources: [{
            id: 'screen', displayName: 'Capture', streamFamily: 'screen', supportedCodecs: ['image.mjpeg'],
        }] } }),
        files: { 'daemon.mjs': "export function activate(api) { api.captureSources.register('screen', { async start() { return { stop() {} }; } }); }" },
    }] });
    const capture = createMachineLiveStreamCaptureRegistry();
    const rpc = new RpcHandlerManager({ scopePrefix: 'capture-machine', encryptionMode: 'plain', logger: () => {} });
    registerDaemonContributionRegistryProjectionHandler(rpc, {
        resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
        resolveCaptureRegistry: () => capture,
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_capture', machineId: 'capture-machine' }),
    });
    const occurrence = fixture.registry.readPluginOccurrenceId?.('acme.viewer');
    if (!occurrence) throw new Error('Missing mounted viewer occurrence');
    const request = { machineId: 'capture-machine', callerPluginId: 'acme.viewer', expectedCallerOccurrenceId: occurrence,
        reference: { kind: 'plugin', source: { pluginId: 'acme.producer', localId: 'screen' } } };
    try {
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, request)).toMatchObject({ ok: true,
            source: { sourceId: 'plugin:acme.producer/screen', requiresApproval: false } });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, { ...request,
            expectedCallerOccurrenceId: 'retired' })).toMatchObject({ ok: false, code: 'plugin_occurrence_stale' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, { ...request,
            machineId: 'other-machine' })).toMatchObject({ ok: false, code: 'capture_source_denied' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, { ...request,
            reference: { kind: 'plugin', source: { pluginId: 'acme.producer', localId: 'missing' } } })).toMatchObject({ ok: false, code: 'capture_source_unavailable' });
    } finally { await fixture.dispose(); }
});

it('keeps a mounted development caller current when its capture producer is replaced', async () => {
    const viewer = createPluginManifestV2Fixture({ id: 'acme.capture-viewer',
        entrypoints: { daemon: './daemon.mjs', development: './daemon.mjs' } });
    const producer = createPluginManifestV2Fixture({ id: 'acme.capture-producer',
        entrypoints: { daemon: './daemon.mjs', development: './daemon.mjs' }, contributes: { captureSources: [{
        id: 'screen', displayName: 'Capture', streamFamily: 'screen', supportedCodecs: ['image.mjpeg'],
    }] } });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [viewer, producer].map(manifest => ({
        manifest, files: { 'daemon.mjs': `export const manifest = ${JSON.stringify(manifest)};
            export function activate(api) { ${manifest.id === producer.id
                ? "api.captureSources.register('screen', { async start() { return { stop() {} }; } });" : ''} }` },
    })) });
    let incumbent: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    let successor: typeof incumbent;
    try {
        const graphs = await Promise.all([viewer, producer].map(async manifest => {
            const rootPath = fixture.committed.generations.get(manifest.id)!.rootPath;
            const source = await resolveLocalPathPluginSource({ locator: rootPath });
            if (!source.ok) throw new Error('Missing authored development source');
            const authority = bindPluginRuntimeSourceAuthority({
                custody: { kind: 'development', registeredRootId: source.pluginRootPath },
                resolvedRoot: source.pluginRootPath, observedRevision: 1,
            });
            if (authority.kind !== 'development') throw new Error('Missing development authority');
            const candidate = await evaluateManifestPluginDevelopmentCandidate({ source, sourceAuthority: authority });
            return [manifest.id, candidate.graph] as const;
        }));
        incumbent = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir, contributes: fixture.registry.contributes,
            generationAuthority: fixture.committed, pluginIds: [viewer.id, producer.id],
            preparedDevelopmentActivationGraphsByPluginId: new Map(graphs),
        });
        let current = incumbent;
        const rpc = new RpcHandlerManager({ scopePrefix: 'capture-machine', encryptionMode: 'plain', logger: () => {} });
        registerDaemonContributionRegistryProjectionHandler(rpc, {
            resolveRuntimeRegistry: async () => current, resolveInstalledPackages: async () => [],
            resolveCaptureRegistry: () => capture,
            resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_capture', machineId: 'capture-machine' }),
        });
        const capture = createMachineLiveStreamCaptureRegistry();
        const callerOccurrence = incumbent.readPluginOccurrenceId?.(viewer.id);
        if (!callerOccurrence) throw new Error('Missing mounted caller occurrence');
        const request = { machineId: 'capture-machine', callerPluginId: viewer.id, expectedCallerOccurrenceId: callerOccurrence,
            reference: { kind: 'plugin', source: { pluginId: producer.id, localId: 'screen' } } };
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, request)).toMatchObject({ ok: true });
        const retained = incumbent.retainPluginActivationComponent?.(viewer.id);
        if (!retained) throw new Error('Missing retained caller activation');
        successor = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir, contributes: incumbent.contributes,
            generationAuthority: fixture.committed, pluginIds: [producer.id],
            retainedActivationRegistryLeases: [retained],
            preparedDevelopmentActivationGraphsByPluginId: new Map(graphs.filter(([id]) => id === producer.id)),
        });
        current = successor;
        await incumbent.dispose();
        const replacement = await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, request);
        expect(replacement, JSON.stringify(replacement)).toMatchObject({ ok: true,
            source: { sourceId: 'plugin:acme.capture-producer/screen',
                sourceOccurrenceId: expect.any(String) } });
        expect(capture.resolve({ sourceId: 'plugin:acme.capture-producer/screen' })).toMatchObject({ ok: true,
            source: { plugin: { occurrenceId: successor.readPluginOccurrenceId?.(producer.id) } } });
        expect(successor.readPluginOccurrenceId?.(viewer.id)).toBe(callerOccurrence);
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, { ...request,
            expectedCallerOccurrenceId: 'retired' })).toMatchObject({ ok: false, code: 'plugin_occurrence_stale' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, { ...request,
            reference: { kind: 'plugin', source: { pluginId: 'acme.unknown', localId: 'screen' } } })).toMatchObject({
                ok: false, code: 'capture_source_unavailable' });
    } finally {
        await successor?.dispose();
        await incumbent?.dispose();
        await fixture.dispose();
    }
});
