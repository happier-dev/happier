import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { manifest, plugin } from './manifest.js';

describe('Machine presence producer availability', () => {
    it.each(['machine-offline', 'machine-online'])('sets up %s for any Machine without reading an inventory', async eventId => {
        const kit = await createPluginTestkit({ manifest, module: plugin });
        // The host Action transport is the boundary; setup and declared schemas stay real.
        const execute = vi.fn(async () => { throw new Error('Aggregate setup must not read a Machine'); });
        const services = { actions: { execute } } satisfies PluginTestServicesFixture;
        try {
            const selected = await kit.invokeAction(`${eventId}/setup`, { v: 1, serverId: 'home' }, { surface: 'agent', services });
            expect(selected).toMatchObject({ v: 1, sourceContractVersion: 1,
                sourceConfig: { v: 1, serverId: 'home', afterRevision: 0 } });
            expect(selected).not.toHaveProperty('sourceConfig.machineId');
            expect(execute).not.toHaveBeenCalled();
        } finally { await kit.dispose(); }
    });

    it.each(['machine-offline', 'machine-online'])('preserves the selected Machine revision for %s', async eventId => {
        const kit = await createPluginTestkit({ manifest, module: plugin });
        const execute = vi.fn(async () => ({ kind: 'present', machineId: 'watched',
            transitions: { v: 1, revision: 7, offline: { revision: 7, occurredAt: 1000 }, online: null }, occurrences: [] }));
        const services = { actions: { execute } } satisfies PluginTestServicesFixture;
        try {
            expect(await kit.invokeAction(`${eventId}/setup`, { v: 1, serverId: 'home', machineId: 'watched' },
                { surface: 'agent', services })).toMatchObject({ sourceConfig: {
                    v: 1, serverId: 'home', machineId: 'watched', afterRevision: 7,
                } });
        } finally { await kit.dispose(); }
    });

    it.each(['machine-offline', 'machine-online'])('preserves exact Machine unavailability for %s', async eventId => {
        const kit = await createPluginTestkit({ manifest, module: plugin });
        const execute = vi.fn(async () => ({ kind: 'refused', code: 'machine_unavailable' }));
        const services = { actions: { execute } } satisfies PluginTestServicesFixture;
        try {
            await expect(kit.invokeAction(`${eventId}/setup`, { v: 1, serverId: 'home', machineId: 'watched' },
                { surface: 'agent', services })).rejects.toMatchObject({ code: 'target_unavailable' });
        } finally { await kit.dispose(); }
    });

    it('declares setup seeds for both native presence transitions without daemon presence observers', () => {
        const eventIds = manifest.contributes?.events?.map(event => event.id) ?? [];
        const actionIds = manifest.contributes?.actions?.map(action => action.id) ?? [];
        const serviceIds = manifest.contributes?.backgroundServices?.map(service => service.id) ?? [];

        for (const id of ['machine-offline', 'machine-online']) {
            expect(eventIds).toContain(id);
            expect(actionIds).toContain(`${id}/setup`);
            // AM2: server transition ownership replaces the old daemon presence observers.
            expect(serviceIds).not.toContain(`${id}-observer`);
            expect(manifest.contributes?.events?.find(event => event.id === id)).toMatchObject({
                kind: 'event', automation: { eligible: true, source: {
                    setupActionRef: { pluginId: manifest.id, localId: `${id}/setup` },
                    nativeActivity: { kind: 'machinePresence', transition: id === 'machine-offline' ? 'offline' : 'online' },
                } },
            });
        }
        expect(eventIds).toContain('deployment-failed');
        expect(eventIds).toContain('rollback-completed');
        expect(eventIds).toContain('health-check-failed');
        expect(eventIds).toContain('health-check-recovered');
        expect(eventIds).toContain('managed-machine-setup-failed');
        expect(eventIds).toContain('mcp-update-available');
    });
});
