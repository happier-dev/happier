import { afterAll, beforeAll, expect, it } from 'vitest';
import {
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    type PluginAvailabilityIntentReadActionOutputV1,
    type PluginAvailabilityIntentsListActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/protocol/automations/event-setup-result';

interface AvailabilityProducer {
    claimCollectionWriters(input: { accountId: string; input: unknown }): Promise<unknown>;
    listIntentIds(input: { accountId: string; input: unknown }): Promise<unknown>;
    readIntent(input: { accountId: string; input: unknown }): Promise<unknown>;
}
interface EventRequest {
    pluginId: string; version: string; eventLocalId: string; sourceContractVersion: number;
    machineId: string; machineInstallationId: string;
}
interface ReaderStore {
    replace(input: { scope: { serverId: string; accountId: string }; snapshot: {
        availabilityCursor: number; intentReads: PluginAvailabilityIntentsListActionOutputV1['intentReads'];
        materializations: []; snapshots: [];
    } }): void;
    bind(scope: { serverId: string; accountId: string }): {
        readCurrentAutomationEventContribution(request: EventRequest): unknown;
        ensureAutomationEventDeclarations(input: { pluginId: string; machineId: string }): Promise<void>;
    };
}

let harness: { close(): Promise<void> };
let service: AvailabilityProducer;
let createStore: (input: {
    loadDeclarationBodies(scope: { serverId: string; accountId: string }, pluginId: string,
        digests: readonly string[]): Promise<NonNullable<PluginAvailabilityIntentReadActionOutputV1['declarationBodies']>>;
}) => ReaderStore;
beforeAll(async () => {
    // Each app retains its own compiler alias program. The existing core runner
    // resolves these real modules by importer; only the test's public ports cross
    // the compiler boundary, as in the Channels collection composed fixture.
    const harnessPath = '../../../../apps/server/sources/testkit/lightSqliteHarness';
    const dbPath = '../../../../apps/server/sources/storage/db';
    const producerPath = '../../../../apps/server/sources/app/plugins/availability/operations';
    const readerPath = '../../../../apps/ui/sources/sync/domains/plugins/availability/reader';
    const serverHarness = await import(harnessPath) as {
        createLightSqliteHarness(input: { tempDirPrefix: string; initEncrypt: boolean }): Promise<typeof harness>;
    };
    harness = await serverHarness.createLightSqliteHarness({ tempDirPrefix: 'plugin-availability-hydration-', initEncrypt: true });
    const { db } = await import(dbPath) as { db: { account: {
        create(input: { data: { id: string; encryptionMode: 'plain' } }): Promise<unknown>;
    } } };
    await db.account.create({ data: { id: 'availability-hydration-owner', encryptionMode: 'plain' } });
    const producer = await import(producerPath) as { createPluginAvailabilityOperations(input: {
        resolveHostingCapability(): { enabled: false }; resolveServerIdentityId(): Promise<string>;
    }): AvailabilityProducer };
    service = producer.createPluginAvailabilityOperations({
        resolveHostingCapability: () => ({ enabled: false }),
        resolveServerIdentityId: async () => 'availability-hydration-home',
    });
    const reader = await import(readerPath) as { createPluginAccountAvailabilityReaderStore: typeof createStore };
    createStore = reader.createPluginAccountAvailabilityReaderStore;
});
afterAll(async () => { await harness?.close(); });

it('hydrates a usable declaration from the real digest-only Account census and exact body read', async () => {
    const accountId = 'availability-hydration-owner';
    const scope = { serverId: 'availability-hydration-home', accountId };
    const pluginId = 'com.acme.hydration';
    const sourceConfigSchema = { type: 'object', properties: {}, additionalProperties: false } as const;
    // Claim through the actual declaration producer; neither digests nor body
    // envelopes are fabricated by the consumer fixture.
    await service.claimCollectionWriters({ accountId, input: { manifest: {
        schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Hydration source',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
        contributes: {
            actions: [{ id: 'setup', title: 'Configure source', scopes: ['global'],
                surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
                inputSchema: sourceConfigSchema,
                resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema) }],
            events: [{ kind: 'event', id: 'changed', title: 'Changed',
                payloadSchema: sourceConfigSchema,
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema,
                    setupActionRef: { pluginId, localId: 'setup' } } } }],
        },
    } } });
    // JSON is the transport boundary. Apply the exact strict readers used by
    // clients before publishing the server's output into the real UI store.
    const census = PluginAvailabilityIntentsListActionOutputV1Schema.parse(JSON.parse(JSON.stringify(
        await service.listIntentIds({ accountId, input: {} }),
    )));
    const exact = PluginAvailabilityIntentReadActionOutputV1Schema.parse(JSON.parse(JSON.stringify(
        await service.readIntent({ accountId, input: { pluginId } }),
    )));
    expect(census.intentReads.map(row => row.pluginId)).toContain(pluginId);
    expect(census.intentReads.find(row => row.pluginId === pluginId)?.response.declarationBodies).toBeUndefined();
    expect(exact.declarationBodies).toBeUndefined();
    expect(exact.currentDeclaration?.declarationDigestSha256).toBeTruthy();
    const bodyReads: string[][] = [];
    const store = createStore({
        loadDeclarationBodies: async (_scope, requestedPluginId, declarationDigests) => {
            bodyReads.push([...declarationDigests]);
            return PluginAvailabilityIntentReadActionOutputV1Schema.parse(JSON.parse(JSON.stringify(
                await service.readIntent({ accountId, input: { pluginId: requestedPluginId, declarationDigests } }),
            ))).declarationBodies ?? [];
        },
    });
    store.replace({ scope, snapshot: { availabilityCursor: census.availabilityCursor,
        intentReads: census.intentReads, materializations: [], snapshots: [] } });
    const reader = store.bind(scope);
    const request = { pluginId, version: '1.0.0', eventLocalId: 'changed', sourceContractVersion: 1,
        machineId: 'hydration-machine', machineInstallationId: 'hydration-installation' };
    expect(reader.readCurrentAutomationEventContribution(request)).toBeNull();
    await reader.ensureAutomationEventDeclarations({ pluginId, machineId: request.machineId });
    expect(reader.readCurrentAutomationEventContribution(request)).toMatchObject({ id: 'changed',
        automation: { source: { setupActionRef: { pluginId, localId: 'setup' } } } });
    // An ordinary exact refresh remains digest-only and preserves the hydrated
    // declaration. The observed request must name the producer's actual digest.
    store.replace({ scope, snapshot: { availabilityCursor: exact.availabilityCursor,
        intentReads: [{ pluginId, response: exact }], materializations: [], snapshots: [] } });
    await reader.ensureAutomationEventDeclarations({ pluginId, machineId: request.machineId });
    expect(reader.readCurrentAutomationEventContribution(request)).toMatchObject({ id: 'changed' });
    expect(bodyReads).toEqual([[exact.currentDeclaration!.declarationDigestSha256]]);
});
