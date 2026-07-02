import { describe, expect, it } from 'vitest';

import { createLocalServiceInventoryRegistry } from './registry';
import { createLocalServiceInventoryRoutes } from './routes';

describe('createLocalServiceInventoryRoutes', () => {
    it('reads snapshots and applies label patches through the inventory registry', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle',
            diagnostics: [],
            entries: [{
                id: 'entry-1',
                machineId: 'machine-a',
                address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
                port: 5173,
                protocol: 'tcp',
                detectedAt: 1_000,
                lastSeenAt: 1_000,
                state: 'listening',
                source: 'detected',
                labels: [],
                confidence: 'high',
                processOwnershipConfidence: 'medium',
                workspaceAssociationConfidence: 'high',
                diagnostics: [],
            }],
        });
        const routes = createLocalServiceInventoryRoutes({ registry });

        expect((await routes.getSnapshot()).entries).toHaveLength(1);
        expect(await routes.patchLabel({
            inventoryId: 'entry-1',
            label: { text: 'Web app' },
            source: 'user',
            now: 2_000,
        })).toEqual({ ok: true });
        expect((await routes.getSnapshot()).entries[0]?.labels.map((label) => label.text)).toEqual(['Web app']);
    });
});
