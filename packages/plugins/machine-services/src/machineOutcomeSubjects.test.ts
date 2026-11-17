import { expect, it } from 'vitest';
import type { HostEventEnvelope } from '@happier-dev/plugin-sdk/events';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/plugin-sdk/events';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { createMachineOutcomeEventSourceAdapter, machineOutcomeEventActions, machineOutcomeEvents } from './machineOutcomeEvents.js';

it('selects any backup before a snapshot exists and retains the producing Machine and Environment subjects', async () => {
    let listener: ((event: HostEventEnvelope<typeof MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1>) => void | Promise<void>) | undefined;
    // The host event transport is the external boundary; source decoding and projection remain real.
    const host = { subscribe(target: { eventId: string }, callback: typeof listener) {
        if (target.eventId === MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1) listener = callback;
        return { dispose() {} };
    } } as unknown as BackgroundServiceContext['services']['events']['host'];
    const adapter = createMachineOutcomeEventSourceAdapter(host, () => 200);
    const definition: PluginCheckpointedEventSourceDefinitionV1 = {
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'any-backup', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId: 'happier.machine.services', localId: 'backup-failed' },
        sourceInstanceId: 'any-backup', sourceContractVersion: 1, sourceConfig: { v: 1, serverId: 'home' },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
            pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' } },
        filter: null, maximumObservationAgeMs: null,
    };
    const source = adapter.decode(definition);
    expect(source).not.toBeNull();
    if (!source) throw new Error('Any-backup source was refused');
    const context = { signal: new AbortController().signal, services: { actions: {
        async execute() { return { status: 'ready', outcomes: [] }; },
    } } } as unknown as BackgroundServiceContext;
    const observe = () => adapter.observe({ context, definition, definitions: [definition], source, isCurrent: async () => true });
    await observe();
    adapter.subscribeWake!(async () => {});
    const fact = { kind: 'backup', serverId: 'home', machineId: 'producer', environmentId: 'environment',
        operationId: 'failed-before-snapshot', state: 'failed', occurredAt: 100, errorCode: 'backup_failed' } as const;
    await listener?.({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' }, payload: fact });
    const observed = await observe();
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]).toMatchObject({ payload: fact, subjectContexts: [
        { role: 'context', subject: { kind: 'machine', serverId: 'home', machineId: 'producer' } },
        { role: 'operand', subject: { kind: 'backup', serverId: 'home', environmentId: 'environment' } },
        { role: 'context', subject: { kind: 'environment', serverId: 'home', environmentId: 'environment' } },
    ] });
});

it('authors one logical backup or pressure source and advertises its native subject kinds', () => {
    for (const event of ['backup-failed', 'backup-succeeded', 'machine-pressure-changed']) {
        expect(machineOutcomeEventActions[event + '/setup']!.inputSchema.safeParse({ v: 1, serverId: 'home' }).success).toBe(true);
        expect(machineOutcomeEventActions[event + '/setup']!.inputSchema.safeParse({ v: 1, serverId: 'home', machineId: 'hidden-selection' }).success).toBe(false);
        expect(machineOutcomeEventActions[event + '/setup']!.inputSchema.safeParse({ v: 1, serverId: 'home', environmentId: 'hidden-selection' }).success).toBe(false);
        expect(machineOutcomeEvents[event]!.declaration.automation).toMatchObject({ subjectKinds:
            event === 'machine-pressure-changed' ? ['machine'] : ['backup', 'environment', 'machine'] });
        if (event !== 'machine-pressure-changed') expect(machineOutcomeEvents[event]!.declaration.automation)
            .toMatchObject({ completesActionIds: ['deployments.backups.run'] });
    }
});

it('observes pressure from any Machine on the selected Home and preserves the native Machine subject', async () => {
    let listener: ((event: HostEventEnvelope<typeof MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1>) => void | Promise<void>) | undefined;
    // Only the authenticated host-event transport is substituted.
    const host = { subscribe(target: { eventId: string }, callback: typeof listener) {
        if (target.eventId === MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1) listener = callback;
        return { dispose() {} };
    } } as unknown as BackgroundServiceContext['services']['events']['host'];
    const adapter = createMachineOutcomeEventSourceAdapter(host, () => 200);
    const definition: PluginCheckpointedEventSourceDefinitionV1 = {
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'any-pressure', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId: 'happier.machine.services', localId: 'machine-pressure-changed' },
        sourceInstanceId: 'any-pressure', sourceContractVersion: 1, sourceConfig: { v: 1, serverId: 'home' },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
            pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' } },
        filter: null, maximumObservationAgeMs: null,
    };
    const source = adapter.decode(definition);
    expect(source).not.toBeNull();
    if (!source) throw new Error('Any-pressure source was refused');
    const context = { signal: new AbortController().signal, services: { actions: {
        async execute() { return { status: 'ready', outcomes: [] }; },
    } } } as unknown as BackgroundServiceContext;
    const observe = () => adapter.observe({ context, definition, definitions: [definition], source, isCurrent: async () => true });
    await observe();
    adapter.subscribeWake!(async () => {});
    const fact = { kind: 'pressure', serverId: 'home', machineId: 'producer', since: 90,
        episode: { kind: 'alert', rule: 'memory', state: 'fired', at: 100 } } as const;
    await listener?.({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' }, payload: { ...fact, serverId: 'other-home' } });
    expect((await observe()).observations).toEqual([]);
    await listener?.({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' }, payload: fact });
    expect((await observe()).observations).toMatchObject([{ payload: fact, subjectContexts: [
        { role: 'context', subject: { kind: 'machine', serverId: 'home', machineId: 'producer' } },
    ] }]);
});

it('recovers another Machine backup through the demanded Account reader and reads only changed summary keys after adoption', async () => {
    const listeners = new Map<string, (event: unknown) => void | Promise<void>>();
    // Authenticated host delivery and Action transport are the two external boundaries.
    const host = { subscribe(target: { eventId: string }, callback: (event: unknown) => void | Promise<void>) {
        listeners.set(target.eventId, callback); return { dispose() { listeners.delete(target.eventId); } };
    } } as unknown as BackgroundServiceContext['services']['events']['host'];
    const reads: unknown[] = [];
    const failed = { kind: 'backup', serverId: 'home', machineId: 'producer', environmentId: 'environment',
        operationId: 'retained-failure', state: 'failed', occurredAt: 100, errorCode: 'backup_failed' } as const;
    const next = { ...failed, operationId: 'next-native-failure', occurredAt: 150 };
    let outcomes: readonly (typeof failed | typeof next)[] = [failed];
    const context = { signal: new AbortController().signal, services: { actions: {
        async execute(actionId: string, input: unknown) {
            expect(actionId).toBe('machines.resources.outcomes.read');
            reads.push(input);
            return { status: 'ready', outcomes };
        },
    } } } as unknown as BackgroundServiceContext;
    const definition: PluginCheckpointedEventSourceDefinitionV1 = {
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'any-backup', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId: 'happier.machine.services', localId: 'backup-failed' },
        sourceInstanceId: 'home-backup', sourceContractVersion: 1, sourceConfig: { v: 1, serverId: 'home' },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
            pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' } },
        filter: null, maximumObservationAgeMs: null,
    };
    const adapter = createMachineOutcomeEventSourceAdapter(host, () => 200);
    const source = adapter.decode(definition);
    expect(source).not.toBeNull();
    if (!source) throw new Error('Any-backup source was refused');
    const attempt = { context, definition, definitions: [definition], source, isCurrent: async () => true };
    const subscription = adapter.subscribeWake!(async () => {});
    const initial = await adapter.observe(attempt);
    expect(initial.observations).toMatchObject([{ payload: failed }]);
    expect(reads).toEqual([{ serverId: 'home' }]);
    if (!initial.checkpoint) throw new Error('The native source omitted its admission checkpoint');
    await adapter.save({ ...attempt, checkpoint: initial.checkpoint });
    expect((await adapter.observe(attempt)).observations).toEqual([]);
    expect(reads).toHaveLength(1);
    outcomes = [failed, next];
    await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: [],
        accountKvChanges: [{ keys: ['unrelated-key', 'workspace:machine-outcome:v1:changed'] }] } });
    const changed = await adapter.observe(attempt);
    expect(changed.observations).toEqual(expect.arrayContaining([expect.objectContaining({ payload: next })]));
    expect(reads).toEqual([{ serverId: 'home' }, { serverId: 'home', keys: ['workspace:machine-outcome:v1:changed'] }]);
    if (changed.checkpoint) await adapter.save({ ...attempt, checkpoint: changed.checkpoint });
    const afterReset = { ...failed, operationId: 'after-cursor-reset', occurredAt: 175 };
    outcomes = [afterReset];
    await listeners.get('@happier/automation/event-sources-invalidated')?.({ payload: { pluginIds: ['unrelated.plugin'] } });
    expect((await adapter.observe(attempt)).observations).toEqual([]);
    expect(reads).toHaveLength(2);
    await listeners.get('@happier/automation/event-sources-invalidated')?.({ payload: {} });
    expect((await adapter.observe(attempt)).observations).toMatchObject([{ payload: afterReset }]);
    expect(reads.at(-1)).toEqual({ serverId: 'home' });
    subscription.dispose();
});
