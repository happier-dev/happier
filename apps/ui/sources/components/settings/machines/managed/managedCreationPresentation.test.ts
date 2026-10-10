import { describe, expect, it } from 'vitest';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import { describeManagedCreation, managedCreationState, managedMachineDestination, managedCreationSetup } from './managedCreationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

const machine: ManagedMachineV1 = { id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: {} },
    desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };

describe('managed creation presentation', () => {
    it.each([
        ['managed.intent.busy', 'busy'],
        ['managed.intent.activity-unknown', 'activityUnknown'],
        ['managed.intent.draining', 'draining'],
    ] as const)('projects %s only from the available current resource operation', (phase, kind) => {
        const operation: ActionOperationProjection = { serverId: machine.homeId, observation: 'available', isUnavailableProjection: false,
            snapshot: { version: 1, operationId: 'retention-operation', revision: 1, actionId: 'machines.managed.delete', state: 'running',
                scope: { accountId: 'owner', machineId: machine.controller.machineId }, title: 'Delete', createdAt: 1, startedAt: 2,
                domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller },
                cancellation: 'supported', progress: { kind: 'phase', phase, label: 'Observed guest activity' } } };
        expect(managedCreationState(machine, { operation })).toEqual({ kind });
        expect(managedCreationState(machine, { operation: { ...operation, observation: 'unavailable' } })).toEqual({ kind: 'resourceReady' });
        expect(managedCreationState({ ...machine, resource: { ...machine.resource!, value: { nativeId: 'replacement' } } }, { operation }))
            .toEqual({ kind: 'resourceReady' });
        expect(managedCreationState(machine, { operation: { ...operation, snapshot: { ...operation.snapshot, state: 'succeeded', settledAt: 3 } } }))
            .toEqual({ kind: 'resourceReady' });
    });
    it('projects setup only after Join and offers recovery only for the same live failed setup', () => {
        const setup = { environment: { setupScript: 'echo setup' }, state: 'failed' as const,
            operation: { operationId: 'setup-operation' }, errorCode: 'setup_failed' };
        expect(managedCreationSetup({ ...machine, environmentSetup: { ...setup, state: 'pending', errorCode: undefined } })).toBeNull();
        expect(managedCreationSetup({ ...machine, enrolledMachineId: 'guest', environmentSetup: setup }))
            .toMatchObject({ state: 'failed', operation: { operationId: 'setup-operation' }, errorCode: 'setup_failed',
                recoveryActions: ['retrySetup', 'continueWithoutSetup', 'delete'] });
        expect(managedCreationSetup({ ...machine, enrolledMachineId: 'guest', environmentSetup: { ...setup, state: 'skipped', errorCode: undefined } }))
            .toMatchObject({ state: 'skipped', recoveryActions: [] });
        expect(managedCreationSetup({ ...machine, enrolledMachineId: 'guest', allocation: 'confirmed-absent', environmentSetup: setup }))
            .toMatchObject({ recoveryActions: [] });
    });
    it('does not manufacture a running or failed installation from a bound resource', () => {
        expect(describeManagedCreation(machine)).toMatchObject({ line: t('managedMachines.creation.resourceReady'), tone: 'neutral' });
        expect(describeManagedCreation({ ...machine, observation: { availability: 'unavailable', observedAt: 1 } }).line)
            .not.toBe(t('managedPower.resourceAbsent'));
        expect(describeManagedCreation({ ...machine, allocation: 'may-exist', resource: undefined }).line)
            .toBe(`${t('managedMachines.creation.unknownCause', { name: 'Guest' })} ${t('managedMachines.creation.unknownDetail')}`);
    });
    it('waits for an offline controller by name before anything is created, and names the provider it confirms with', () => {
        const unsubmitted = { ...machine, allocation: 'unsubmitted' as const, resource: undefined };
        expect(managedCreationState(unsubmitted, { controller: { name: 'MacBook Pro', online: false }, provider: 'Hetzner' }))
            .toEqual({ kind: 'controllerWaiting', name: 'Guest', controller: 'MacBook Pro', provider: 'Hetzner' });
        expect(managedCreationState(unsubmitted, { controller: { name: 'MacBook Pro', online: true }, provider: 'Hetzner' }))
            .toEqual({ kind: 'creationWaiting', name: 'Guest' });
        expect(managedCreationState(unsubmitted)).toEqual({ kind: 'creationWaiting', name: 'Guest' });
        const starting: ManagedMachineV1 = { ...machine, desired: 'start',
            submittedNativeEffect: { intentRevision: 1, requestId: 'start-request', intent: 'start', controller: machine.controller },
            observation: { availability: 'present', observedAt: 10, power: 'stopped', storage: 'retained' } };
        expect(managedCreationState(starting, { provider: 'Hetzner' })).toMatchObject({ kind: 'powerPending', provider: 'Hetzner' });
    });
    it('keeps cancellation cleanup visible and only treats confirmed absence as ended', () => {
        const canceled = { ...machine, creationState: 'canceled' as const, cleanup: { disposition: 'pending' as const, reason: 'late_allocation' } };
        expect(describeManagedCreation(canceled)).toMatchObject({ line: t('managedMachines.creation.canceledCleanup'), tone: 'warning' });
        expect(describeManagedCreation({ ...canceled, allocation: 'confirmed-absent', cleanup: undefined }).line)
            .toBe(t('managedPower.resourceAbsent'));
    });
    it('reopens an enrolled managed URL through the ordinary Machine owner in its original Home', () => {
        expect(managedMachineDestination(machine, 'srv/a')).toBeNull();
        expect(managedMachineDestination({ ...machine, enrolledMachineId: 'joined machine' }, 'srv/a'))
            .toBe('/machine/joined%20machine?serverId=srv%2Fa');
    });
    it('keeps submitted Stop pending until observed stopped, and never treats lost storage as offline', () => {
        const pending = { ...machine, desired: 'stop' as const,
            submittedNativeEffect: { intentRevision: 1, requestId: 'stop-request', intent: 'stop' as const, controller: machine.controller },
            observation: { availability: 'present' as const, observedAt: 10, power: 'running' as const, storage: 'retained' as const } };
        expect(managedCreationState(pending)).toEqual({ kind: 'stopPending' });
        expect(managedCreationState({ ...pending, submittedNativeEffect: undefined,
            observation: { ...pending.observation, power: 'stopped' } })).toEqual({ kind: 'stoppedStorage' });
        expect(managedCreationState({ ...machine,
            observation: { availability: 'present', observedAt: 20, power: 'stopped', storage: 'lost' } })).toEqual({ kind: 'volumeLost' });
    });
    it('keeps a submitted Start pending while the last observation still says stopped', () => {
        const starting: ManagedMachineV1 = { ...machine, desired: 'start',
            submittedNativeEffect: { intentRevision: 1, requestId: 'start-request', intent: 'start', controller: machine.controller },
            observation: { availability: 'present', observedAt: 10, power: 'stopped', storage: 'retained' } };
        expect(managedCreationState(starting).kind).toBe('powerPending');
        expect(managedCreationState({ ...starting, observation: { ...starting.observation!, power: 'running' } }).kind).toBe('resourceReady');
    });
});
