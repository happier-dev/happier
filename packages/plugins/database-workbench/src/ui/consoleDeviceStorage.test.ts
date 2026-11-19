import { expect, it } from 'vitest';
import type { DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiSemanticSurfaceAdapter } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiDeviceStateResultV1 } from '@happier-dev/plugin-sdk/ui';
import { createConsoleDeviceStorage } from './consoleDeviceStorage.js';

const descriptor = {
    target: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' },
        source: { kind: 'service', serviceId: 'api', variable: 'DATABASE_URL' } },
    placement: { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation' },
} satisfies Pick<DatabaseDescriptorV1, 'target' | 'placement'>;

// The semantic adapter is the rendering boundary; the SDK transport and host validation remain real.
const adapter: PluginUiSemanticSurfaceAdapter<null> = { async mount() { return {
    async snapshot() { return { revision: 1, nodes: [] }; }, async update() {}, async invoke() {}, async dispose() {},
}; } };

async function storageFixture() {
    const values = new Map<string, Extract<PluginUiDeviceStateResultV1, { status: 'ready' }>['value']>();
    let unavailable = false;
    const fixture = await createPluginUiTestkit({
        identity: { instanceId: 'database-console', mountNonce: 'draft-test' },
        authorPlugin: { id: 'com.happier.database-workbench', version: '1.0.0' },
        surface: null, surfaceContext: createSurfaceContextFixture(), adapter,
        handlers: { deviceState(request) {
            if (unavailable) return { status: 'unavailable', reason: 'storage_unavailable' };
            if (request.operation === 'write') values.set(request.key, request.value);
            if (request.operation === 'remove') values.delete(request.key);
            return { status: 'ready', value: values.get(request.key) ?? null };
        } },
    });
    return { fixture, values, failStorage() { unavailable = true; } };
}

it('persists SQL/history through the real host transport, isolating Machine and structured target', async () => {
    const { fixture, values } = await storageFixture();
    try {
        const storage = createConsoleDeviceStorage(fixture.context.hostApi, descriptor);
        await expect(storage.read()).resolves.toBeNull();
        const state = { sql: 'select $1', history: [{ sql: 'select 1', parameters: ['private'] }],
            parameters: ['private'], results: [{ value: 'private' }], cellOperands: ['private'] };
        await storage.write(state);
        const reopened = createConsoleDeviceStorage(fixture.context.hostApi, descriptor);
        await expect(reopened.read()).resolves.toEqual({ sql: 'select $1', history: [{ sql: 'select 1' }] });
        const { source, ...targetFields } = descriptor.target;
        await expect(createConsoleDeviceStorage(fixture.context.hostApi, {
            ...descriptor, target: { source, ...targetFields },
        }).read()).resolves.toEqual({ sql: 'select $1', history: [{ sql: 'select 1' }] });
        expect([...values.values()]).toEqual([{ sql: 'select $1', history: [{ sql: 'select 1' }] }]);
        await expect(createConsoleDeviceStorage(fixture.context.hostApi, {
            ...descriptor, placement: { ...descriptor.placement, machineId: 'other-machine' },
        }).read()).resolves.toBeNull();
        await expect(createConsoleDeviceStorage(fixture.context.hostApi, {
            ...descriptor, target: { ...descriptor.target, source: { ...descriptor.target.source, serviceId: 'other-service' } },
        }).read()).resolves.toBeNull();
    } finally { await fixture.dispose(); }
});

it('rejects malformed persisted drafts and exposes unavailable storage without erasing them', async () => {
    const { fixture, values, failStorage } = await storageFixture();
    try {
        const storage = createConsoleDeviceStorage(fixture.context.hostApi, descriptor);
        await storage.write({ sql: 'select 1', history: [] });
        const key = [...values.keys()][0]!;
        values.set(key, { sql: 'select 1', history: [{ sql: 42 }] });
        await expect(storage.read()).rejects.toBeInstanceOf(TypeError);
        expect(values.get(key)).toEqual({ sql: 'select 1', history: [{ sql: 42 }] });
        failStorage();
        await expect(storage.read()).rejects.toThrow('storage_unavailable');
        await expect(storage.write({ sql: 'select 2', history: [] })).rejects.toThrow('storage_unavailable');
    } finally { await fixture.dispose(); }
});
