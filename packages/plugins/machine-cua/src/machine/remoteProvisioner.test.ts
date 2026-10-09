import { describe, expect, it } from 'vitest';
import { CUA_PLUGIN } from '../manifest.js';
import { ByocProvisionerSchemas, FleetProvisionerSchemas, FleetReconciliationSchemas } from './remoteProvisionerSchemas.js';
import * as stored from './remoteProvisionerSchemas.js';

describe('Cua remote provisioner public author contract', () => {
    it('keeps native resource ingress strict and preserves the admitted resource in canonical acquire output', () => {
        const byoc = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned', ownedAttachmentIds: [] };
        const fleet = { namespace: 'pool', claimId: 'happier-owned' };
        for (const [schemas, resource] of [[ByocProvisionerSchemas, byoc], [FleetProvisionerSchemas, fleet]] as const) {
            expect(schemas.resourceInput.safeParse({ resource: { ...resource, token: 'private' } }).success).toBe(false);
            expect(schemas.acquireResult.parse({ kind: 'bound', resource: { contributionRef: { pluginId: CUA_PLUGIN.manifest.id,
                localId: resource === byoc ? 'byoc' : 'fleet' }, schemaVersion: 1, value: resource } })).toMatchObject({ resource: { value: resource } });
        }
    });

    it('reopens stored additions through the SDK reader without weakening native ingress', async () => {
        const byoc = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned', ownedAttachmentIds: [] };
        const fleet = { namespace: 'pool', claimId: 'happier-owned' };
        const byocReaders = await stored.prepareCuaByocStoredSchemas();
        const fleetReaders = await stored.prepareCuaFleetStoredSchemas();
        expect(byocReaders.resourceStored.parse({ ...byoc, future: { token: 'private' } })).toEqual(byoc);
        expect(fleetReaders.resourceStored.parse({ ...fleet, future: { token: 'private' } })).toEqual(fleet);
        expect(fleetReaders.launchStored.parse({ namespace: 'pool', runtimeId: 'kubevirt', imageId: 'image', sizeId: 'pool',
            nativeLease: { durationSeconds: 3600, future: true }, future: true })).toEqual({ namespace: 'pool', runtimeId: 'kubevirt',
                imageId: 'image', sizeId: 'pool', nativeLease: { durationSeconds: 3600 } });
        expect(fleetReaders.resourceStored.safeParse({ ...fleet, namespace: '../pool' }).success).toBe(false);
        expect(byocReaders.resourceStored.safeParse({ ...byoc, cloud: 'other' }).success).toBe(false);
    });

    it('retains the exact pending Fleet claim in the canonical acquire and stored recovery contracts', async () => {
        const claim = { namespace: 'pool', claimId: 'happier-owned' };
        const pending = { kind: 'pending', nativeOperationRef: { contributionRef: { pluginId: CUA_PLUGIN.manifest.id,
            localId: 'fleet' }, schemaVersion: 1, value: claim } };
        expect(FleetProvisionerSchemas.acquireResult.safeParse(pending).success).toBe(true);
        expect(FleetProvisionerSchemas.acquireResult.parse(pending)).toEqual(pending);
        expect(FleetReconciliationSchemas.input.parse({ nativeOperation: claim })).toEqual({ nativeOperation: claim });
        expect(FleetReconciliationSchemas.input.safeParse({ nativeOperation: { ...claim, token: 'private' } }).success).toBe(false);
        expect(FleetReconciliationSchemas.result.parse({ kind: 'bound', resource: { ...pending.nativeOperationRef,
            value: { ...claim, sandboxId: 'native-guest' },
        } })).toMatchObject({ resource: { value: { ...claim, sandboxId: 'native-guest' } } });
        expect(FleetProvisionerSchemas.acquireResult.safeParse({ ...pending, nativeOperationRef: {
            ...pending.nativeOperationRef, value: { ...claim, token: 'private' },
        } }).success).toBe(false);
        const readers = await stored.prepareCuaFleetStoredSchemas();
        expect(readers.nativeOperationStored.parse({ ...claim, future: { token: 'private' } })).toEqual(claim);
        expect(readers.nativeOperationStored.safeParse({ ...claim, namespace: '../pool' }).success).toBe(false);
    });
});
