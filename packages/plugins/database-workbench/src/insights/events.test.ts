import { describe, expect, it } from 'vitest';
import { PluginEventAutomationDeclarationV1Schema, readAutomationEventSubjectKindsV1 } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { decideDatabaseAccessV1 } from '@happier-dev/databases';
import { createPluginTestkit, createTestResourceInvocationContext, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { DATABASE_STATS_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { createDatabaseActions } from '../actions.js';
import { createDatabaseRuntime, type DatabaseOperationAdmission } from '../runtime.js';
import { createDatabaseConnectionResourceRuntime } from '../resources.js';
import { plugin as nativePlugin } from '../manifest.js';
import { createDatabaseInsightProducers } from './findings.js';
import { DATABASE_FINDING_EVENT_REF, DATABASE_FINDING_SETUP_LOCAL_ID, databaseFindingEventSourceInstanceId } from './events.js';
import { createNativeFindingFixture, target, invocation } from './nativeFixture.testkit.js';

async function fixture(native: Awaited<ReturnType<typeof createNativeFindingFixture>>, services: PluginTestServicesFixture, held: boolean) {
    const { resolve } = native;
    const unusedSecret = async (): Promise<never> => { throw new Error('The SQLite fixture already owns its selected path'); };
    const resourceContext = createTestResourceInvocationContext({ ...invocation, requesterAccount: { accountId: 'alice' },
        secrets: { readSavedSecret: unusedSecret },
        context: { kind: 'surface', mountInstanceKey: 'fixture', launchInput: { operation: 'describe', target } } });
    const producer = held ? await createDatabaseConnectionResourceRuntime({ resolve }).createProducer!(resourceContext) : undefined;
    const admit: DatabaseOperationAdmission = async ({ access }) => {
        const decision = decideDatabaseAccessV1({ operation: access, requester: 'person', agentAccess: 'none',
            person: { mayWrite: true, editingOff: false } });
        if (!decision.ok) throw new PluginError({ code: decision.refusal });
        return decision;
    };
    const runtime = createDatabaseRuntime({ resolve, admit });
    const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions({
        ...runtime, ...createDatabaseInsightProducers({ executeResolvedOperation: runtime.executeResolvedOperation, admit }),
    }) });
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { ...services,
        ...(producer ? { resources: { ...resourceContext.resources, async invokeDemand(input, options) {
            return producer.invoke!(input.input, { signal: options?.signal ?? resourceContext.signal });
        } } } : {}),
    } });
    return { ...kit, async dispose() { await kit.dispose(); await producer?.dispose(); } };
}


describe('native completed observation admission', () => {
    it('registers a usable Event source setup without acquiring a database', async () => {
        const kit = await createPluginTestkit({ manifest: nativePlugin.manifest, module: nativePlugin });
        try {
            const source = { v: 1, subject: { kind: 'database', serverId: 'server', target }, sourceScope: { serverId: 'server', machineId: 'machine' } } as const;
            expect(await kit.invokeAction(DATABASE_FINDING_SETUP_LOCAL_ID, source, invocation)).toMatchObject({
                sourceInstanceId: databaseFindingEventSourceInstanceId(source), sourceContractVersion: 1, sourceConfig: source,
            });
            expect(nativePlugin.manifest.contributes.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: DATABASE_FINDING_EVENT_REF.localId, automation: expect.objectContaining({ eligible: true }) }),
            ]));
            const event = nativePlugin.manifest.contributes.events?.find(row => row.id === DATABASE_FINDING_EVENT_REF.localId);
            // Resource trigger authoring consumes this owner result, not the payload's subject field.
            expect(readAutomationEventSubjectKindsV1(PluginEventAutomationDeclarationV1Schema.parse(event?.automation))).toEqual(['database']);
        } finally { await kit.dispose(); }
    });

    it.each([false, true])('admits a completed native stats read through AE (held demand: %s) without database content', async held => {
        const admissions: unknown[] = [];
        const source = { v: 1, subject: { kind: 'database', serverId: 'server', target }, sourceScope: { serverId: 'server', machineId: 'machine' } } as const;
        const setup = await createPluginTestkit({ manifest: nativePlugin.manifest, module: nativePlugin });
        const definitions = await (async () => {
            try {
                const neighbor = { ...source, subject: { ...source.subject, target: { ...target, savedSecretId: 'other-database' } } };
                const sources = [
                    ['exact', source, '22222222-2222-4222-8222-222222222222'],
                    ['other-exact', neighbor, '33333333-3333-4333-8333-333333333333'],
                    ['any', { v: 1, sourceScope: source.sourceScope }, '44444444-4444-4444-8444-444444444444'],
                ] as const;
                return await Promise.all(sources.map(async ([triggerId, setupInput, sourceSelectorId]) => {
                    const { sourceInstanceId, sourceContractVersion, sourceConfig } = await setup.invokeAction(
                        DATABASE_FINDING_SETUP_LOCAL_ID, setupInput, invocation,
                    ) as { sourceInstanceId: string; sourceContractVersion: number; sourceConfig: unknown };
                    expect(sourceConfig).toEqual(setupInput);
                    return {
                        sourceInstanceId, sourceContractVersion, sourceConfig,
                        automationId: '11111111-1111-4111-8111-111111111111', triggerId, triggerRevision: 1,
                        eventRef: DATABASE_FINDING_EVENT_REF, sourceSelectorId,
                        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: { pluginId: 'happier.database', machineId: 'machine', materializationId: 'fixture' } },
                        filter: null, maximumObservationAgeMs: null,
                    };
                }));
            } finally {
                await setup.dispose();
            }
        })();
        // Host Action transport is the system boundary; native SQL, projections and AE admission remain real.
        const actions = { async execute(actionId: string, input: unknown) {
            if (actionId === 'automation.event.sources.list') {
                const { source } = input as { source: { sourceInstanceId: string } };
                return { kind: 'page', revision: '1', nextCursor: null,
                    definitions: definitions.filter(definition => definition.sourceInstanceId === source.sourceInstanceId) };
            }
            if (actionId === 'automation.event.admit') { admissions.push(input); return { results: [{ kind: 'admitted', checkpointSafe: true, runId: 'run-1' }] }; }
            if (actionId === 'automation.event.source.status.report') return {};
            throw new Error(`Unexpected host Action ${actionId}`);
        } } as unknown as NonNullable<PluginTestServicesFixture['actions']>;
        const native = await createNativeFindingFixture();
        const kit = await fixture(native, { actions }, held);
        try {
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1),
                { operation: 'stats.read', target, ...(held ? { subscriptionId: 'fixture' } : {}),
                    request: { kind: 'stats.read', group: 'tables', selection: { schema: 'main', page: { rows: 20 } } } }, invocation))
                .toMatchObject({ ok: true, observation: { status: 'available', group: 'tables' } });
            expect(admissions).toEqual(expect.arrayContaining([
                expect.objectContaining({ definitions: [expect.objectContaining({ triggerId: 'exact' })] }),
                expect.objectContaining({ definitions: [expect.objectContaining({ triggerId: 'any' })] }),
            ]));
            expect(admissions).toHaveLength(2);
            expect(native.sqlReads()).toBe(1); // Emission consumes completed evidence; it performs no second SQL read.
            expect(JSON.stringify(admissions)).not.toContain('first');
            expect(JSON.stringify(admissions)).not.toContain('CREATE');
            expect(admissions[0]).toMatchObject({ subjectContexts: [{ role: 'operand', subject: source.subject }],
                payload: { subject: source.subject,
                    observation: { sourceScope: source.sourceScope, kind: 'tables', summary: { records: 2 } } } });
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1),
                { operation: 'stats.read', target, ...(held ? { subscriptionId: 'fixture' } : {}),
                    request: { kind: 'stats.read', group: 'statements', selection: { page: { rows: 20 }, order: 'calls' } } }, invocation))
                .toMatchObject({ ok: true, observation: { status: 'unavailable' } });
            expect(admissions).toHaveLength(2);
            expect(native.sqlReads()).toBe(1);
        } finally { await kit.dispose(); await native.dispose(); }
    });
});
