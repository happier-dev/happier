import { describe, expect, it } from 'vitest';
import { manifest } from './manifest.js';

describe('Machine presence producer availability', () => {
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
