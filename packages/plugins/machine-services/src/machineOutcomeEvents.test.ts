import { expect, it } from 'vitest';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, BackupOutcomeEventV1ProtocolSchema, MachinePressureEventV1ProtocolSchema,
    type HostEventEnvelope } from '@happier-dev/plugin-sdk/events';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { createMachineOutcomeEventSourceAdapter } from './machineOutcomeEvents.js';
import { PLUGIN_MANIFEST } from './manifest.js';

const pluginId = 'happier.machine.services';
const source = { v: 1 as const, serverId: 'home', machineId: 'machine', environmentId: 'environment' };
function definition(event: string): PluginCheckpointedEventSourceDefinitionV1 {
    return { automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'watch', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId, localId: event },
        sourceInstanceId: event, sourceContractVersion: 1, sourceConfig: source,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: { pluginId, machineId: 'machine', materializationId: 'installed' } },
        filter: null, maximumObservationAgeMs: null };
}
it('offers settled machine events and their setup Actions through the existing When catalog', () => {
    for (const localId of ['backup-failed', 'backup-succeeded', 'machine-pressure-changed', 'worktree.removed']) {
        const event = PLUGIN_MANIFEST.contributes.events?.find(row => row.id === localId);
        expect(event?.kind).toBe('event');
        expect(event && 'automation' in event && event.automation).toMatchObject({ eligible: true,
            source: { setupActionRef: { pluginId, localId: localId + '/setup' }, supportedObservationTransports: ['checkpointedPull'] } });
        expect(PLUGIN_MANIFEST.contributes.actions?.find(row => row.id === localId + '/setup')).toBeDefined();
    }
});
it.each([true, false])('projects a successful removal with Workspace association %s as the exact original worktree fact without requiring a backup Environment', async associated => {
    let listener: ((event: HostEventEnvelope<typeof MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1>) => void | Promise<void>) | undefined;
    // The authenticated host transport is the boundary; delivery and source matching remain real.
    const host = { subscribe(_target: unknown, callback: typeof listener) { listener = callback; return { dispose() {} }; } } as unknown as BackgroundServiceContext['services']['events']['host'];
    const adapter = createMachineOutcomeEventSourceAdapter(host, () => 200);
    const selected = { ...definition('worktree-removed'), sourceConfig: { v: 1, serverId: 'home', machineId: 'machine' } };
    const decoded = adapter.decode(selected);
    expect(decoded).not.toBeNull();
    if (!decoded) throw new Error('Expected valid removal source');
    const context = { signal: new AbortController().signal } as BackgroundServiceContext;
    const observe = () => adapter.observe({ context, definition: selected, definitions: [selected], source: decoded, isCurrent: async () => true });
    await observe();
    const wakes: string[] = [];
    adapter.subscribeWake!(async sourceId => { if (sourceId) wakes.push(sourceId); });
    const removal = {
        workspace: associated ? { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/original' } : null,
        project: null, machineId: 'machine', operationId: 'retire', worktreePath: '/original',
        outcome: 'removed' as const, removalKind: 'retired' as const,
    };
    await listener?.({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' },
        payload: { kind: 'worktreeRemoved', serverId: 'home', occurredAt: 100, removal } });
    const observed = await observe();
    expect(wakes).toEqual(['worktree-removed']);
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]).toMatchObject({ occurredAt: 100, payload: removal });
});
it('projects each matched settled run and pressure transition once, retains arrivals during admission, and has zero idle reads', async () => {
    let listener: ((event: HostEventEnvelope<typeof MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1>) => void | Promise<void>) | undefined;
    let disposed = false;
    // Authenticated host-event transport is the boundary; the adapter and schemas remain real.
    const host = { subscribe(_target: unknown, callback: typeof listener) { listener = callback; return { dispose() { disposed = true; } }; } } as unknown as BackgroundServiceContext['services']['events']['host'];
    const adapter = createMachineOutcomeEventSourceAdapter(host, () => 200);
    const definitions = ['backup-failed', 'backup-succeeded', 'machine-pressure-changed', 'worktree.removed'].map(definition);
    const context = { signal: new AbortController().signal } as BackgroundServiceContext;
    const observe = async (definition: PluginCheckpointedEventSourceDefinitionV1) => {
        const decoded = adapter.decode(definition);
        if (!decoded) throw new Error('Expected valid source');
        return adapter.observe({ context, definition, definitions, source: decoded, isCurrent: async () => true });
    };
    const save = async (definition: PluginCheckpointedEventSourceDefinitionV1, page: Awaited<ReturnType<typeof observe>>) => {
        if (!page.checkpoint) throw new Error('Expected admission checkpoint');
        await adapter.save({ context, definition, definitions, source, isCurrent: async () => true, checkpoint: page.checkpoint });
    };
    const wakes: string[] = [];
    const subscription = adapter.subscribeWake!(async sourceId => { if (sourceId) wakes.push(sourceId); });
    for (const row of definitions) expect((await observe(row)).observations).toEqual([]);
    const emit = async (payload: HostEventEnvelope<typeof MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1>['payload']) =>
        listener?.({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' }, payload });
    const backup = BackupOutcomeEventV1ProtocolSchema.parse({ kind: 'backup', serverId: 'home', machineId: 'machine',
        environmentId: 'environment', operationId: 'failed-run', state: 'failed', occurredAt: 99, errorCode: 'backup_failed' });
    await emit({ ...backup, machineId: 'other' });
    await emit({ ...backup, environmentId: 'other' });
    expect(wakes).toEqual([]);
    await emit(backup);
    await emit({ ...backup, operationId: 'good-run', state: 'succeeded', errorCode: null });
    for (const rule of ['memory', 'cpu', 'disk'] as const) {
        for (const state of ['fired', 'recovered'] as const) await emit(MachinePressureEventV1ProtocolSchema.parse({
            kind: 'pressure', serverId: 'home', machineId: 'machine', since: 100,
            episode: { kind: 'alert', rule, state, at: state === 'fired' ? 102 : 103, ...(rule === 'disk' ? { volumeId: 'root' } : {}) },
        }));
    }
    const failed = await observe(definitions[0]);
    expect(failed.observations.map(row => row.payload)).toEqual([backup]);
    await emit({ ...backup, operationId: 'next-run', occurredAt: 104 });
    await save(definitions[0], failed);
    const next = await observe(definitions[0]);
    expect(next.observations.map(row => row.payload)).toEqual([{ ...backup, operationId: 'next-run', occurredAt: 104 }]);
    const succeeded = await observe(definitions[1]);
    const pressure = await observe(definitions[2]);
    expect(succeeded.observations).toHaveLength(1);
    expect(pressure.observations).toHaveLength(6);
    expect(new Set(pressure.observations.map(row => row.occurrenceId)).size).toBe(6);
    for (const [index, page] of [[0, next], [1, succeeded], [2, pressure]] as const) {
        await save(definitions[index], page);
        const idle = await observe(definitions[index]);
        expect(idle.observations).toEqual([]);
        expect(idle.nextEligibleAt).toBeNull();
    }
    await adapter.retire!({ context, definitions: [], revision: 'removed', isCurrent: async () => true });
    const before = wakes.length;
    await emit(backup);
    expect(wakes).toHaveLength(before);
    subscription.dispose();
    expect(disposed).toBe(true);
});
