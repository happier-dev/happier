import { describe, expect, it } from 'vitest';

import { createLocalServicePreviewRoutes } from './routes';
import { createLocalServicePreviewRegistry } from './registry';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';

const MACHINE_ID = 'machine-a';

function inventoryEntry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-vite',
        machineId: MACHINE_ID,
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: {
            scheme: 'http',
            host: '127.0.0.1',
            port: 5173,
            probeState: 'ready',
            probedAt: 2_000,
        },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        presentation: { addressLabel: 'localhost:5173', displayName: 'Vite' },
        ...overrides,
    };
}

function inventoryRegistryWith(entries: readonly NormalizedLocalServiceInventoryEntry[]) {
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({
        v: 1,
        machineId: MACHINE_ID,
        generatedAt: 1_000,
        refreshState: 'idle',
        entries,
        diagnostics: [],
    });
    return registry;
}

describe('createLocalServicePreviewRoutes lifecycle', () => {
    it('openOrCreate registers a loopback inventory entry and mints its accessUrl', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({
            machineId: MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.response.status).toBe('created');
        expect(result.response.preview.accessUrl).toBe('http://127.0.0.1:5173/');
        expect(result.response.preview.resource.browserTarget?.kind).toBe('localServicePreview');
        // The snapshot now reflects the registered preview.
        expect(result.response.snapshot.previews).toHaveLength(1);
    });

    it('openOrCreate uses the daemon-detected HTTPS endpoint scheme for detected services', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry({
                port: 8443,
                presentation: { addressLabel: 'localhost:8443', displayName: 'Secure app' },
                endpoint: {
                    scheme: 'https',
                    host: '127.0.0.1',
                    port: 8443,
                    probeState: 'ready',
                    probedAt: 2_000,
                },
            })]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({
            machineId: MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.response.preview.accessUrl).toBe('https://127.0.0.1:8443/');
        expect(result.response.preview.resource.target).toMatchObject({
            scheme: 'https',
            host: '127.0.0.1',
            port: 8443,
        });
    });

    it('openOrCreate refuses detected services whose endpoint scheme is still unknown', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry({
                endpoint: {
                    scheme: 'unknown',
                    host: '127.0.0.1',
                    port: 5173,
                    probeState: 'unknown',
                    probedAt: 2_000,
                    reasonCode: 'endpoint_probe_failed',
                },
            })]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });

        expect(result).toEqual({ ok: false, reasonCode: 'endpoint_scheme_unknown' });
    });

    it('openOrCreate is idempotent: a second call returns the existing preview', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            now: () => 1_000,
        });

        await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        const second = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });

        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.response.status).toBe('existing');
        expect(second.response.snapshot.previews).toHaveLength(1);
    });

    it('openOrCreate refuses an unknown inventory entry', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'nope' });

        expect(result).toEqual({ ok: false, reasonCode: 'unknown_inventory_entry' });
    });

    it('openOrCreate refuses a cross-machine request', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
        });

        const result = await routes.openOrCreate({ machineId: 'other', inventoryEntryId: 'entry-vite' });

        expect(result).toEqual({ ok: false, reasonCode: 'wrong_machine' });
    });

    it('revoke unregisters a preview and reports it gone from the snapshot', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            now: () => 1_000,
        });
        const created = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const previewId = created.response.preview.previewId;

        const revoked = await routes.revoke({ machineId: MACHINE_ID, previewId });

        expect(revoked.ok).toBe(true);
        if (!revoked.ok) return;
        expect(revoked.response.revoked).toBe(true);
        expect(revoked.response.snapshot.previews).toHaveLength(0);
    });

    it('revoke of a non-existent preview reports revoked:false (idempotent)', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            now: () => 1_000,
        });

        const result = await routes.revoke({ machineId: MACHINE_ID, previewId: 'missing' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.response.revoked).toBe(false);
    });
});
