import { expect, it, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { manifest } from '../../../../../packages/plugins/machine-services/src/manifest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { projectAccountEntitiesInvalidationForHost } from '@/daemon/events/accountEntityInvalidation';

it('bridges retained managed setup settlement through the ordinary Event runner without replaying or disclosing setup', async () => {
    expect(manifest.contributes?.events?.some(event => event.id === 'managed-machine-setup-failed')).toBe(true);
    const { createManagedSetupEventSourceAdapter } = await import('../../../../../packages/plugins/machine-services/src/managedSetupEvents');
    let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'fixture.setup', localId: 'machine' }, schemaVersion: 1, name: 'private', choices: {} },
        preset: { id: 'preset', revision: 1 }, allocation: 'bound',
        resource: { contributionRef: { pluginId: 'fixture.setup', localId: 'machine' }, schemaVersion: 1, value: { id: 'native' } },
        creationState: 'active', enrolledMachineId: 'guest',
        desired: 'start', desiredWhen: 'now', intentRevision: 0, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        machineSetup: { setup: { scripts: [{ body: 'private script' }] }, state: 'failed',
            operation: { operationId: 'operation' }, errorCode: 'setup_failed', settledAtMs: 30 } });
    const materialization = { pluginId: manifest.id, machineId: 'observer', materializationId: 'installed' };
    let definition: PluginCheckpointedEventSourceDefinitionV1 = { automationId: '11111111-1111-4111-8111-111111111111',
        triggerId: 'setup-trigger', triggerRevision: 1, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        eventRef: { pluginId: manifest.id, localId: 'managed-machine-setup-failed' }, sourceInstanceId: 'managed-setup:source',
        sourceContractVersion: 1, sourceConfig: { v: 1, homeId: 'home', managedId: 'managed', observingSince: 20 },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null };
    const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
    type Listener = (event: { payload: JsonValue }) => void | Promise<void>;
    const listeners = new Map<string, Set<Listener>>();
    const emit = async (entityIds: string[]) => {
        for (const listener of listeners.get('@happier/account/entities-invalidated') ?? []) await listener({ payload: { entityIds } });
    };
    let safe = false;
    // Host Actions and committed push delivery are external plugin boundaries;
    // schemas, setup source, SDK lifecycle and admission normalization are real.
    const execute = vi.fn(async (id: string, input: Record<string, unknown>) => {
        if (id === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions: [definition], nextCursor: null };
        if (id === 'automation.event.source.status.report') return { kind: 'reported' };
        if (id === 'machines.managed.get') return machine;
        if (id === 'automation.event.admit') {
            admissions.push(AutomationEventAdmitInputV1Schema.parse(input));
            return { results: safe ? [{ kind: 'admitted', checkpointSafe: true, runId: 'run' }] : [] };
        }
        throw new Error(`Unexpected Action ${id}`);
    });
    const context = { plugin: { id: manifest.id, version: manifest.version }, contribution: { id: 'managed-setup-observer',
        qualifiedId: `${manifest.id}/backgroundServices/managed-setup-observer` }, surface: 'background', invokedAtMs: 40,
        materialization, signal: new AbortController().signal, services: { actions: { execute }, events: { host: {
            subscribe(target: { eventId: string }, listener: (event: { payload: JsonValue }) => void | Promise<void>) {
                const group = listeners.get(target.eventId) ?? new Set<Listener>();
                listeners.set(target.eventId, group); group.add(listener);
                return { dispose() { group.delete(listener); } };
            },
        } } } } as unknown as BackgroundServiceContext;
    const adapter = createManagedSetupEventSourceAdapter(context.services.events.host, () => 40);
    adapter.subscribeWake?.(async () => {});
    const cycle = (source = adapter) => runCheckpointedPluginEventObserverV1({ context, source, mode: 'once', now: () => 40 });
    await cycle(); safe = true; await cycle();
    expect(admissions).toHaveLength(2);
    expect(admissions[0]).toEqual(admissions[1]);
    expect(admissions[0].payload).toEqual({ homeId: 'home', managedId: 'managed', machineId: 'guest',
        operationId: 'operation', state: 'failed', errorCode: 'setup_failed', observedAt: 30 });
    await cycle(); expect(admissions).toHaveLength(2);
    expect(execute.mock.calls.filter(([id]) => id === 'machines.managed.get')).toHaveLength(1);
    await emit(['unrelated']);
    await cycle(); expect(admissions).toHaveLength(2);
    const body = UpdateBodySchema.parse({ t: 'account-change', entityIds: ['managed', 'managed'] });
    if (body.t !== 'account-change') throw new Error('Expected Account change');
    const committed = projectAccountEntitiesInvalidationForHost(body);
    expect(committed).toEqual({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' }, payload: { entityIds: ['managed'] } });
    if (committed) await emit(committed.payload.entityIds);
    await cycle(); expect(admissions[2].occurrenceId).toBe(admissions[0].occurrenceId);
    await cycle(createManagedSetupEventSourceAdapter(context.services.events.host, () => 40));
    expect(admissions[3].occurrenceId).toBe(admissions[0].occurrenceId);
    definition = { ...definition, sourceConfig: { ...definition.sourceConfig as object, observingSince: 31 } };
    await cycle(); expect(admissions).toHaveLength(4);
    machine = ManagedMachineV1Schema.parse({ ...machine, machineSetup: { ...machine.machineSetup,
        operation: { operationId: 'retry' }, settledAtMs: 35 } });
    await emit(['managed']);
    await cycle(); expect(admissions).toHaveLength(5);
    expect(admissions[4].occurrenceId).not.toBe(admissions[0].occurrenceId);
});
