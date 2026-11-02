import { describe, expect, it } from 'vitest';

import { createDeploymentEnvironmentDetailV1 } from '../testing/v1.js';
import { DeploymentEnvironmentContentV1Schema } from './environment.js';
import * as schemas from './index.js';

const backup = {
    configRevision: 1,
    destinationRef: { pluginId: 'example.storage', localId: 'remote' },
    occurrenceId: 'storage-occurrence-1',
    config: { bucket: 'recovery', prefix: 'environment-a' },
    credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
    sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
    ownership: { environmentId: 'environment-a', prefix: 'environment-a' },
    retention: { kind: 'keepEverything' },
};

describe('Environment backup content', () => {
    const content = createDeploymentEnvironmentDetailV1().content;

    it('preserves strict JSON configuration values and detached nested snapshots', () => {
        const shared = { enabled: true };
        const config = { empty: {}, values: [null, false, 1.5, Number.MAX_VALUE, '\ud800'], shared, again: shared };
        const parsed = schemas.DeploymentBackupConfigurationV1Schema.parse({ ...backup, config });
        expect(parsed.config).toEqual(config);
        expect(parsed.config.shared).not.toBe(shared);
        expect(Object.isFrozen(parsed.config.shared)).toBe(true);
        shared.enabled = false;
        expect(parsed.config.shared).toEqual({ enabled: true });

        const nullPrototype: unknown = Object.create(null, { bucket: { value: 'recovery', enumerable: true } });
        expect(schemas.DeploymentBackupConfigurationV1Schema.parse({ ...backup, config: nullPrototype }).config)
            .toEqual({ bucket: 'recovery' });
        const branded = Object.defineProperty({ bucket: 'recovery' }, Symbol('brand'), { value: true });
        expect(schemas.DeploymentBackupConfigurationV1Schema.parse({ ...backup, config: branded }).config)
            .toEqual({ bucket: 'recovery' });
        expect(schemas.DeploymentBackupConfigurationV1Schema.parse({ ...backup, config: {} }).config).toEqual({});
    });

    it('rejects non-object configurations and strict JSON violations before reading accessors', () => {
        let reads = 0;
        const accessor = Object.defineProperty({}, 'bucket', { enumerable: true, get: () => { reads++; return 'recovery'; } });
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const inherited: unknown = Object.create({ bucket: 'recovery' });
        const hidden = Object.defineProperty({}, 'bucket', { value: 'recovery' });
        const symbol = { [Symbol('visible')]: 'recovery' };
        const sparse = new Array<unknown>(1);
        const extraArrayProperty = Object.assign(['recovery'], { extra: true });
        for (const config of [
            null, true, 1, 'recovery', [], undefined, accessor, inherited, hidden, symbol, new Date(0), new Map(),
            { value: undefined }, { value: () => true }, { value: Symbol('value') }, { value: 1n },
            { value: NaN }, { value: Infinity }, { value: -Infinity }, { value: cycle },
            { value: accessor }, { value: inherited }, { value: hidden }, { value: symbol },
            { value: sparse }, { value: extraArrayProperty }, { value: new Date(0) },
        ]) {
            expect(schemas.DeploymentBackupConfigurationV1Schema.safeParse({ ...backup, config }).success).toBe(false);
        }
        expect(reads).toBe(0);
    });

    it('retains configured recovery intent and the explicit no-backup policy through the real content boundary', () => {
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...content, backup }).backup).toEqual(backup);
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...content, backup: { notNeeded: true } }).backup)
            .toEqual({ notNeeded: true });
        expect(DeploymentEnvironmentContentV1Schema.parse(content)).not.toHaveProperty('backup');
        const selected = { ...backup, retention: { kind: 'keep', last: 7, monthly: 3 },
            sources: [{ kind: 'volume', sourceId: 'uploads', service: 'app', volume: 'uploads', consistency: 'stopDuringCopy' }] };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...content, backup: selected }).backup).toEqual(selected);
    });

    it('rejects duplicate custody identities, secret references, ambiguous sources and invented retention', () => {
        for (const invalid of [
            { ...backup, credentialBindings: [...backup.credentialBindings, ...backup.credentialBindings] },
            { ...backup, credentialBindings: [{ ...backup.credentialBindings[0], ref: { id: 'secret' } }] },
            { ...backup, credentialBindings: [{ ...backup.credentialBindings[0], configKey: 'other' }] },
            { ...backup, sources: [...backup.sources, ...backup.sources] },
            { ...backup, sources: [{ ...backup.sources[0], targetLinkId: 'managed' }] },
            { ...backup, retention: { kind: 'keep' } },
            { ...backup, retention: { kind: 'keep', last: 0 } },
            { ...backup, notNeeded: true },
            { notNeeded: true, actorId: 'person', at: 1 },
        ]) expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...content, backup: invalid }).success).toBe(false);
    });

    it('rejects a configured backup without any source to snapshot', () => {
        expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...content, backup: { ...backup, sources: [] } }).success)
            .toBe(false);
    });

    it('keeps configure storage on the existing Artifact CAS envelope', () => {
        const schema = Reflect.get(schemas, 'DeploymentEnvironmentBackupSetInputV1Schema') as
            { safeParse: (value: unknown) => { success: boolean } } | undefined;
        const reference = { serverId: 'home', environmentId: 'environment-a', expectedRevision: 1,
            contentArtifactId: 'artifact-a', contentHeaderVersion: 1, contentBodyVersion: 1 };
        expect(schema?.safeParse(reference).success).toBe(true);
        expect(schema?.safeParse({ ...reference, backup }).success).toBe(false);
        expect(schema?.safeParse({ ...reference, patch: { backup } }).success).toBe(false);
    });

    it('retains exact native manifest evidence and requires a dump producer checksum', () => {
        const schema = Reflect.get(schemas, 'DeploymentBackupManifestV1Schema') as
            { safeParse: (value: unknown) => { success: boolean } } | undefined;
        const manifest = { schemaVersion: 1, environmentId: 'environment-a', sourceId: 'database', kind: 'dump',
            configRevision: 1, repositoryId: 'a'.repeat(64), producerChecksumSha256: 'd'.repeat(64),
            snapshot: { snapshotId: 'b'.repeat(64), treeId: 'c'.repeat(64), hostname: 'happier-env-environment-a',
                time: '2026-10-30T19:00:00Z', paths: ['/db.dump'], tags: ['happier', 'env:environment-a'] },
            totalBytesProcessed: 123, totalFilesProcessed: 1 };
        expect(schema?.safeParse(manifest).success).toBe(true);
        for (const invalid of [
            { ...manifest, producerChecksumSha256: undefined },
            { ...manifest, repositoryId: 'short' },
            { ...manifest, snapshot: { ...manifest.snapshot, snapshotId: 'short' } },
            { ...manifest, snapshot: { ...manifest.snapshot, treeId: 'short' } },
            { ...manifest, secret: 'unadmitted' },
        ]) expect(schema?.safeParse(invalid).success).toBe(false);
    });

    it('validates opaque nonsecret destination fields through the selected closed descriptor', () => {
        const validate = Reflect.get(schemas, 'validateDeploymentBackupDestinationConfigurationV1') as
            ((input: unknown) => boolean) | undefined;
        const descriptor = { id: 'remote', title: 'External storage',
            configSchema: { type: 'object', properties: { bucket: { type: 'string', minLength: 1 } },
                required: ['bucket'], additionalProperties: false },
            credentialRoles: ['repositoryPassword'], resticTransport: 's3', locality: 'offHost',
            actions: { test: { pluginId: 'example.storage', localId: 'test' },
                open: { pluginId: 'example.storage', localId: 'open' } } };
        expect(validate?.({ descriptor, config: { bucket: 'recovery' } })).toBe(true);
        for (const config of [{ bucket: '' }, { bucket: 1 }, {}, { bucket: 'recovery', password: 'secret' }]) {
            expect(validate?.({ descriptor, config })).toBe(false);
        }
    });
});
