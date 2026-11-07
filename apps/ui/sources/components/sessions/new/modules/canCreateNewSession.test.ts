import { describe, expect, it } from 'vitest';

import { canCreateNewSession } from '@/components/sessions/new/modules/canCreateNewSession';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

describe('canCreateNewSession', () => {
    it('allows the selected asleep shared target with an admitted wake fact, while retaining access refusals', () => {
        const selectedMachine = { ...createMachineFixture({ id: 'guest', active: false, activeAt: 0, isShared: true,
            access: { custodian: { accountId: 'owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }),
            managedInputRuntime: { nativeReady: false, wakeState: 'asleep' as const, newSessionWake: { kind: 'available' as const } } };
        const input = { selectedMachineId: 'guest', selectedMachine, selectedPath: '/work',
            scope: { serverId: 'home', accountId: 'member' } };
        expect(canCreateNewSession(input)).toBe(true);
        expect(canCreateNewSession({ ...input, selectedMachine: { ...selectedMachine,
            managedInputRuntime: { ...selectedMachine.managedInputRuntime, newSessionWake: { kind: 'unavailable', reason: 'no_controller' } } } })).toBe(false);
        expect(canCreateNewSession({ ...input, selectedMachine: { ...selectedMachine,
            managedInputRuntime: { ...selectedMachine.managedInputRuntime, newSessionWake: undefined } } })).toBe(false);
        expect(canCreateNewSession({ ...input, selectedMachine: { ...selectedMachine, active: true, activeAt: Date.now(),
            managedInputRuntime: { ...selectedMachine.managedInputRuntime, newSessionWake: { kind: 'unavailable', reason: 'no_controller' } } } })).toBe(true);
        expect(canCreateNewSession({ ...input, selectedMachine: { ...selectedMachine, managedInputRuntime: undefined } })).toBe(false);
        expect(canCreateNewSession({ ...input, selectedMachine: { ...selectedMachine,
            access: { ...selectedMachine.access!, accessState: 'key_pending' as const } } })).toBe(false);
        expect(canCreateNewSession({ ...input, selectedMachine: { ...selectedMachine, revokedAt: 1 } })).toBe(false);
    });
    it('admits a reviewed managed recipe without a Machine projection, but not unresolved provider choices', () => {
        const managedMachineSelection = createManagedMachineSelectionDraft({
            selection: { kind: 'preset', homeId: 'srv_home', id: 'preset', revision: 1 },
            receipt: {
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            },
        });
        const params = { selectedMachineId: null, selectedMachine: null, selectedPath: '/authored', managedMachineSelection };
        expect(canCreateNewSession(params)).toBe(true);
        expect(canCreateNewSession({ ...params, selectedPath: ' ' })).toBe(false);
        expect(canCreateNewSession({ ...params, selectedPath: '', directoryKind: 'managed' })).toBe(true);
        expect(canCreateNewSession({ ...params, managedMachineSelection: { ...managedMachineSelection,
            receipt: { ...managedMachineSelection.receipt, optionStatus: 'loading' } } })).toBe(false);
    });
    it('admits the matching grant-bound managed machine without an Account machine projection', () => {
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'bound-machine',
            selectedMachine: null,
            selectedPath: '',
            directoryKind: 'managed',
            hostBoundMachineId: 'bound-machine',
        })).toBe(true);
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'other-machine',
            selectedMachine: null,
            selectedPath: '',
            directoryKind: 'managed',
            hostBoundMachineId: 'bound-machine',
        })).toBe(false);
    });
    it('allows an interactive temporary-computer target without inventing a selected machine', () => {
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: null,
            selectedMachine: null,
            selectedPath: '',
            executionTarget: {
                kind: 'temporary_computer',
                serverId: 'home-1',
                workspace: { kind: 'choose_on_endpoint' },
                artifactTarget: 'linux-x64',
            },
        })).toBe(true);
    });
    it('fails closed when machine is missing', () => {
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: null,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('requires a selected machine id and a non-empty path', () => {
        const machine: any = { id: 'm1', active: true, activeAt: Date.now() };

        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: null,
            selectedMachine: machine,
            selectedPath: '/repo',
        })).toBe(false);

        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: machine,
            selectedPath: '   ',
        })).toBe(false);
    });

    it('returns false when selected machine is offline', () => {
        const offlineMachine: any = { id: 'm1', active: false, activeAt: 0 };
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: offlineMachine,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('returns false when selected machine was replaced', () => {
        const replacedMachine: any = {
            id: 'm-old',
            active: true,
            activeAt: Date.now(),
            replacedByMachineId: 'm-new',
            replacedAt: Date.now(),
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
        };

        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm-old',
            selectedMachine: replacedMachine,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('returns true when selected machine has exact spawn readiness', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
            spawnReadiness: { status: 'ready', machineId: 'm1' },
        })).toBe(true);
    });

    it('allows an online machine to attempt launch before exact spawn readiness resolves', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
        })).toBe(true);
    });

    it('allows an online machine to attempt launch while exact spawn readiness is unknown', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
            spawnReadiness: { status: 'unknown', machineId: 'm1' },
        })).toBe(true);
    });

    it('blocks launch when exact spawn readiness has a confirmed unavailable status', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
            spawnReadiness: { status: 'rpcUnavailable', machineId: 'm1' },
        })).toBe(false);
    });

    it('needs no folder for a no-folder session, and still needs a ready machine', () => {
        const machine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: machine,
            selectedPath: '',
            directoryKind: 'managed',
        })).toBe(true);
        expect(canCreateNewSession({
            scope: { serverId: 'creation-home', accountId: 'creation-account' },
            selectedMachineId: 'm1',
            selectedMachine: null,
            selectedPath: '',
            directoryKind: 'managed',
        })).toBe(false);
    });
});
