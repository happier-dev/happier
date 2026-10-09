import { describe, expect, it } from 'vitest';

import { byocCleanupTarget, decodeCreatedByocResource, inspectByocLedger, qualifyByocLaunch } from './byoc.js';
import { bindFleetSandbox, decodeFleetClaim, fleetClaimTarget } from './fleet.js';
import { ByocLaunchV1Schema, FleetLaunchV1Schema } from './remoteSchemas.js';
import { ByocProvisionerSchemas, FleetProvisionerSchemas } from './remoteProvisionerSchemas.js';

const launch = { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium',
    nativeLifetime: { kind: 'no-native-ttl' } };
const provider = { name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0,
    kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.0416 }] };
const nativeRow = { provider: 'aws', id: 'i-owned', type: 'instance', sandbox: 'aws:owned',
    machine: 'cloud-owned', region: 'us-west-2', state: 'running', expires: '', expired: false };
const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned',
    spaceId: 'relay:cloud-owned', ownedAttachmentIds: ['sg-owned'] };
const claimRef = { namespace: 'reviewed-pool', claimId: 'our-claim' };
const checkedAt = Date.parse('2026-10-08T12:00:00Z');
function claim(status?: { phase: string; sandbox?: { name: string } }, lifecycle?: { shutdownTime?: string; autoRenew?: boolean }) {
    return { name: 'our-claim', namespace: 'reviewed-pool', json: JSON.stringify({
        metadata: { name: 'our-claim', namespace: 'reviewed-pool', creationTimestamp: '2026-10-08T11:00:00Z' },
        spec: { sandboxTemplateRef: { name: 'reviewed-image' }, ttlSecondsAfterCreated: 7200, ...(lifecycle && { lifecycle }) },
        ...(status && { status }),
    }) };
}

describe('Cua BYOC native qualification and exact identity', () => {
    it('uses only the reviewed cloud, region, image, size and native TTL without changing defaults', () => {
        expect(qualifyByocLaunch(launch, provider)).toMatchObject({ kind: 'qualified', on: 'aws', ttlSeconds: 0,
            price: { amount: '0.0416', currency: 'USD', unit: 'hour' } });
        expect(qualifyByocLaunch(launch, { ...provider, name: 'gcp' }).kind).toBe('unavailable');
        expect(qualifyByocLaunch(launch, { ...provider, region: 'us-east-1' }).kind).toBe('unavailable');
        // Public native SDK/CLI create has no BYOC TTL override. Do not invent a
        // flag or change native connection defaults to satisfy this admission.
        expect(qualifyByocLaunch(launch, { ...provider, ttl_hours: 8 }).kind).toBe('unavailable');
        expect(qualifyByocLaunch({ ...launch, nativeSizeId: 'other-size' }, provider).kind).toBe('unavailable');
        expect(provider.ttl_hours).toBe(0);
    });
    it('preserves a qualified finite Modal lifetime and rejects no-TTL and beyond its native 24 hour ceiling', () => {
        const modal = { ...launch, cloud: 'modal', nativeLifetime: { kind: 'finite', durationSeconds: 3600 } };
        expect(qualifyByocLaunch(modal, { ...provider, name: 'modal', ttl_hours: 1 })).toMatchObject({ kind: 'qualified', ttlSeconds: 3600 });
        expect(ByocLaunchV1Schema.safeParse({ ...modal, nativeLifetime: { kind: 'no-native-ttl' } }).success).toBe(false);
        expect(ByocLaunchV1Schema.safeParse({ ...modal, nativeLifetime: { kind: 'finite', durationSeconds: 86401 } }).success).toBe(false);
    });
    it('captures only the created sandbox native resource and its owned attachments', () => {
        expect(decodeCreatedByocResource(launch, 'aws:owned', [nativeRow,
            { ...nativeRow, id: 'sg-owned', type: 'security_group' },
            { ...nativeRow, id: 'i-other', sandbox: 'aws:other' },
            { ...nativeRow, id: 'sg-shared', type: 'security_group', sandbox: '' },
        ])).toEqual({ kind: 'bound', resource });
        expect(byocCleanupTarget(resource)).toBe('aws:owned');
        expect(ByocProvisionerSchemas.acquireResult.safeParse({ kind: 'bound', resource: {
            contributionRef: { pluginId: 'test.machine-cua', localId: 'byoc' }, schemaVersion: 1, value: resource,
        } }).success).toBe(true);
        // Family admission validates the declared native value, not just an
        // envelope carrying arbitrary native JSON or a resource from Fleet.
        expect(ByocProvisionerSchemas.acquireResult.safeParse({ kind: 'bound', resource: {
            contributionRef: { pluginId: 'test.machine-cua', localId: 'byoc' }, schemaVersion: 1, value: claimRef,
        } }).success).toBe(false);
    });
    it('keeps cleanup unknown when only the registry vanished or the native ledger still contains attachments', () => {
        expect(inspectByocLedger(resource, []).existence).toBe('unknown');
        expect(inspectByocLedger(resource, [{ ...nativeRow, id: 'sg-owned', type: 'security_group' }])).toMatchObject({ existence: 'unknown' });
        expect(inspectByocLedger(resource, [nativeRow])).toMatchObject({ existence: 'unknown', power: 'unknown', recordedPower: 'running' });
        expect(decodeCreatedByocResource(launch, 'aws:owned', [{ ...nativeRow, state: 'pending' }]).kind).toBe('unknown');
    });
});

describe('Cua Fleet native claim identity and independent expiry', () => {
    it('retains the exact claim before sandbox binding and derives the native creation-age expiry', () => {
        expect(decodeFleetClaim(claim({ phase: 'Pending' }), claimRef, checkedAt)).toEqual({
            kind: 'pending', resource: claimRef, nativeExpiryAt: Date.parse('2026-10-08T13:00:00Z'),
            expirySource: 'native-creation-ttl', resume: 'unsupported',
        });
        expect(FleetProvisionerSchemas.resourceInput.safeParse({ resource: claimRef }).success).toBe(true);
        expect(FleetProvisionerSchemas.resourceInput.safeParse({ resource }).success).toBe(false);
    });
    it('binds only this claim and never adopts another sandbox or replaces an existing binding', () => {
        const sandbox = { name: 'sandbox-one', namespace: 'reviewed-pool', claim: 'our-claim', services: ['spacesd'], token: 'private' };
        expect(bindFleetSandbox(claimRef, sandbox)).toEqual({ kind: 'bound', resource: { ...claimRef, sandboxId: 'sandbox-one' } });
        expect(bindFleetSandbox(claimRef, { ...sandbox, claim: 'other-claim' }).kind).toBe('unknown');
        expect(bindFleetSandbox({ ...claimRef, sandboxId: 'original' }, sandbox).kind).toBe('unknown');
        expect(fleetClaimTarget({ ...claimRef, sandboxId: 'sandbox-one' })).toEqual({ namespace: 'reviewed-pool', name: 'our-claim' });
    });
    it('reports ended lifetime without claiming absence or promise of same-resource resume', () => {
        expect(decodeFleetClaim(claim({ phase: 'Bound', sandbox: { name: 'sandbox-one' } }, { shutdownTime: '2026-10-08T11:59:00Z' }), claimRef, checkedAt))
            .toMatchObject({ kind: 'ended', resource: { ...claimRef, sandboxId: 'sandbox-one' },
                nativeExpiryAt: Date.parse('2026-10-08T11:59:00Z'), expirySource: 'native-shutdown', resume: 'unsupported' });
    });
    it('does not claim a fixed expiry for vendor auto-renew and keeps unknown vendor states unknown', () => {
        expect(decodeFleetClaim(claim({ phase: 'Pending' }, { shutdownTime: '2026-10-08T11:59:00Z', autoRenew: true }), claimRef, checkedAt))
            .toMatchObject({ kind: 'pending', nativeExpiryAt: Date.parse('2026-10-08T13:00:00Z'), expirySource: 'native-creation-ttl' });
        expect(decodeFleetClaim(claim({ phase: 'NewVendorState' }), claimRef, checkedAt).kind).toBe('unknown');
    });
    it('refuses a mismatched record/resource identity and ignores vendor private additions', () => {
        expect(decodeFleetClaim({ ...claim(), namespace: 'other-pool' }, claimRef, checkedAt).kind).toBe('unknown');
        const raw = JSON.parse(claim({ phase: 'Pending' }).json);
        raw.metadata.name = 'other-claim';
        expect(decodeFleetClaim({ ...claim(), json: JSON.stringify(raw) }, claimRef, checkedAt).kind).toBe('unknown');
        expect(FleetLaunchV1Schema.safeParse({ namespace: 'p', runtimeId: 'r', imageId: 'i', sizeId: 's', nativeLease: { durationSeconds: 0 } }).success).toBe(false);
        // Route labels forbid trailing whitespace; returned sandbox ids remain opaque.
        expect(FleetLaunchV1Schema.safeParse({ namespace: 'reviewed-pool\n', runtimeId: 'gvisor', imageId: 'i',
            sizeId: 's', nativeLease: { durationSeconds: 60 } }).success).toBe(false);
        expect(FleetProvisionerSchemas.resourceInput.safeParse({ resource: { ...claimRef, claimId: 'our-claim\n' } }).success).toBe(false);
    });
    it('preserves the admitted claim during unreadable observations and dropped binding', () => {
        expect(decodeFleetClaim({ ...claim(), json: '{' }, claimRef, checkedAt)).toEqual({ kind: 'unknown', resource: claimRef });
        expect(bindFleetSandbox(claimRef, undefined)).toEqual({ kind: 'unknown', resource: claimRef });
        expect(decodeFleetClaim(claim({ phase: 'Bound', sandbox: { name: 'replacement' } }),
            { ...claimRef, sandboxId: 'original' }, checkedAt)).toEqual({ kind: 'unknown', resource: { ...claimRef, sandboxId: 'original' } });
    });
});
