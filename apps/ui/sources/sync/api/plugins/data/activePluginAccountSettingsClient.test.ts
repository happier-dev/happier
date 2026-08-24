import { describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';

import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilitySnapshot,
} from '@/sync/domains/plugins/availability/reader';
import type {
    ScopedPluginSettingsAdapter,
    ScopedPluginSettingsReadInput,
    ScopedPluginSettingsWriteInput,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { createAccountScopedPluginSettingsTransport } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';

import { createActivePluginAccountSettingsClient } from './activePluginAccountSettingsClient';

/**
 * The plugin's own Account Settings scope, reached from a mounted surface.
 *
 * The point of this client is that a plugin's UI and its daemon side read and
 * write ONE record with ONE contract. So the assertions below are all parity
 * assertions against the daemon's `ScopedSettingsService`: an absent record
 * reads as revision `0`, a snapshot carries stored values only (never declared
 * defaults), `get` falls back to the declared default, a value the declared
 * schema refuses is refused here too, a secret field is refused rather than
 * materialized, and a stale `expectedRevision` is a typed conflict rather than
 * a lost write.
 *
 * Only the Account record boundary is replaced — the HTTP/encryption edge, a
 * genuine system boundary. The declaration projection, the field admission, the
 * read-before-write merge and the CAS decision underneath are all real.
 */

const pluginId = 'example.notes';

const normalizedManifest = PluginManifestV2Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: 'Notes',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        settings: [{
            id: 'notes',
            title: 'Notes',
            target: { kind: 'plugin' },
            scope: 'account',
            fields: [{
                id: 'notes.views',
                title: 'Views',
                schema: {
                    type: 'object',
                    properties: { v: { type: 'integer', const: 1 } },
                    required: ['v'],
                    additionalProperties: false,
                },
                default: { v: 1 },
                presentation: { hidden: true },
            }, {
                id: 'notes.token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
            }],
        }],
    },
});

function createAvailabilityReader() {
    const snapshot = {
        availabilityCursor: 3,
        materializations: [],
        snapshots: [],
        intentReads: [{
            pluginId,
            response: {
                availabilityCursor: 3,
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: {
                    pluginId,
                    desiredVersion: '1.0.0',
                    enabled: true,
                    offlineUiHosting: 'enabled',
                    writableCollections: [],
                    revision: 'intent-3',
                },
                release: {
                    ref: { pluginId, version: '1.0.0' },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest,
                    collectionContracts: [],
                    uiSlots: [],
                    packageAssetArchive: {
                        archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                        resources: [],
                    },
                },
                uiArtifacts: [],
            },
        }],
    } satisfies PluginAccountAvailabilitySnapshot;
    return createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot,
    });
}

/**
 * One in-memory Account plugin-settings record behind the REAL account
 * transport, so the read-before-write merge and the row CAS are the shipped
 * ones rather than a second implementation.
 */
function createRecordHarness() {
    let record: Readonly<{ revision: number; values: Record<string, unknown> }> | null = null;
    const writes: unknown[] = [];
    const transport = createAccountScopedPluginSettingsTransport({
        async readRecord() {
            return record === null
                ? { status: 'absent' }
                : { status: 'present', revision: record.revision, values: record.values };
        },
        async writeRecord(input) {
            writes.push({ expectedRevision: input.expectedRevision, values: input.values });
            const current = record === null ? 'absent' : record.revision;
            if (input.expectedRevision !== current) {
                return { status: 'conflict', revision: record?.revision ?? 0 };
            }
            const revision = (record?.revision ?? 0) + 1;
            record = { revision, values: { ...input.values } };
            return { status: 'updated', revision };
        },
    });
    const adapter: Pick<ScopedPluginSettingsAdapter, 'read' | 'write'> = {
        read: (input: ScopedPluginSettingsReadInput) => transport.read({
            pluginId: input.pluginId,
            target: input.target as never,
            fields: input.fields,
        }),
        write: (input: ScopedPluginSettingsWriteInput) => transport.write(input as never),
    };
    return {
        adapter,
        writes,
        seed(values: Record<string, unknown>, revision = 1) { record = { revision, values }; },
        current: () => record,
    };
}

function createClient(harness: ReturnType<typeof createRecordHarness>) {
    return createActivePluginAccountSettingsClient({
        pluginId,
        accountLifetime: {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => {} }),
        },
        availabilityReader: createAvailabilityReader(),
        adapter: harness.adapter,
        resolveAccountServerIdentityId: () => 'server-identity-a',
    });
}

describe('the mounted surface\'s Account Settings client', () => {
    it('reads an absent record as revision 0 with no declared defaults folded in, and returns the default only from get', async () => {
        const harness = createRecordHarness();
        const client = createClient(harness);

        const snapshot = await client.snapshot();
        expect(snapshot).toEqual({ scope: { kind: 'account' }, revision: '0', values: {} });
        // The daemon returns stored values only. Folding the declared default
        // into the snapshot would turn "nothing has ever been written" into "an
        // empty set was written", which is a different answer to every owner
        // that distinguishes absence from an empty parsed value.
        await expect(client.get('notes.views')).resolves.toEqual({ v: 1 });
    });

    it('writes through the record CAS and reports the new revision the plugin can write against next', async () => {
        const harness = createRecordHarness();
        const client = createClient(harness);

        await expect(client.set('notes.views', { v: 1 }, { expectedRevision: '0' }))
            .resolves.toEqual({ scope: { kind: 'account' }, revision: '1' });
        expect(harness.writes).toEqual([{ expectedRevision: 'absent', values: { 'notes.views': { v: 1 } } }]);
        await expect(client.snapshot()).resolves.toEqual({
            scope: { kind: 'account' },
            revision: '1',
            values: { 'notes.views': { v: 1 } },
        });

        await expect(client.reset('notes.views', { expectedRevision: '1' }))
            .resolves.toEqual({ scope: { kind: 'account' }, revision: '2' });
        await expect(client.snapshot()).resolves.toMatchObject({ revision: '2', values: {} });
    });

    it('refuses a stale revision as a typed conflict instead of overwriting the newer record', async () => {
        const harness = createRecordHarness();
        harness.seed({ 'notes.views': { v: 1 } }, 7);
        const client = createClient(harness);

        await expect(client.set('notes.views', { v: 1 }, { expectedRevision: '6' }))
            .rejects.toMatchObject({ code: 'plugin_settings_revision_conflict' });
        // The losing write never reached the record boundary at all.
        expect(harness.writes).toEqual([]);
        expect(harness.current()).toEqual({ revision: 7, values: { 'notes.views': { v: 1 } } });
    });

    it('refuses an undeclared id, a secret field, and a value the declared schema rejects', async () => {
        const harness = createRecordHarness();
        const client = createClient(harness);

        await expect(client.get('notes.unknown'))
            .rejects.toMatchObject({ code: 'plugin_settings_unknown_id' });
        await expect(client.get('notes.token'))
            .rejects.toMatchObject({ code: 'plugin_settings_secret_materialization_required' });
        await expect(client.set('notes.views', { v: 2 }))
            .rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });
        expect(harness.writes).toEqual([]);
    });

    it('reports the Account as unavailable when the current release admits no Settings declaration', async () => {
        const harness = createRecordHarness();
        const client = createActivePluginAccountSettingsClient({
            pluginId: 'example.absent',
            accountLifetime: {
                scope: { serverId: 'server-a', accountId: 'account-a' },
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            },
            availabilityReader: createAvailabilityReader(),
            adapter: harness.adapter,
            resolveAccountServerIdentityId: () => 'server-identity-a',
        });

        await expect(client.snapshot())
            .rejects.toMatchObject({ code: 'plugin_settings_persistence_unavailable' });
    });

    it('rejects a stale mount before resolving an unknown setting id', async () => {
        const harness = createRecordHarness();
        const client = createActivePluginAccountSettingsClient({
            pluginId,
            accountLifetime: {
                scope: { serverId: 'server-a', accountId: 'account-a' },
                isCurrent: () => false,
                onRetire: () => ({ dispose: () => {} }),
            },
            availabilityReader: createAvailabilityReader(),
            adapter: harness.adapter,
            resolveAccountServerIdentityId: () => 'server-identity-a',
        });

        // A retired Account scope has no authority to resolve a declaration or
        // expose whether a field is known. The daemon service checks currentness
        // before field lookup; a mounted surface must preserve that order.
        await expect(client.get('notes.unknown'))
            .rejects.toMatchObject({ code: 'plugin_settings_persistence_unavailable' });
        expect(harness.writes).toEqual([]);
    });
});
