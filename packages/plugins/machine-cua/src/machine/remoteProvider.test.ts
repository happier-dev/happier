import { describe, expect, it } from 'vitest';

import { decodeCreatedByocResource, qualifyByocLaunch } from './byoc.js';
import { ByocLaunchV1Schema } from './remoteSchemas.js';
import { ByocProvisionerSchemas } from './remoteProvisionerSchemas.js';

const launch = { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium',
    nativeLifetime: { kind: 'no-native-ttl' } };
const provider = { name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0,
    kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.0416 }] };
const nativeRow = { provider: 'aws', id: 'i-owned', type: 'instance', sandbox: 'aws:owned',
    machine: 'cloud-owned', region: 'us-west-2', state: 'running', expires: '', expired: false };
const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned',
    spaceId: 'relay:cloud-owned', ownedAttachmentIds: ['sg-owned'] };

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
        expect(ByocProvisionerSchemas.acquireResult.safeParse({ kind: 'bound', resource: {
            contributionRef: { pluginId: 'test.machine-cua', localId: 'byoc' }, schemaVersion: 1, value: resource,
        } }).success).toBe(true);
        // Family admission validates the declared native value, not just an
        // envelope carrying arbitrary native JSON.
        expect(ByocProvisionerSchemas.acquireResult.safeParse({ kind: 'bound', resource: {
            contributionRef: { pluginId: 'test.machine-cua', localId: 'byoc' }, schemaVersion: 1, value: { unrelated: 'native' },
        } }).success).toBe(false);
    });
    it('keeps pending native identity unknown', () => {
        expect(decodeCreatedByocResource(launch, 'aws:owned', [{ ...nativeRow, state: 'pending' }]).kind).toBe('unknown');
    });
});
