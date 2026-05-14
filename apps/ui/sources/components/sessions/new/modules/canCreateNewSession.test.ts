import { describe, expect, it } from 'vitest';

import { canCreateNewSession } from '@/components/sessions/new/modules/canCreateNewSession';

describe('canCreateNewSession', () => {
    it('fails closed when machine is missing', () => {
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: null,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('requires a selected machine id and a non-empty path', () => {
        const machine: any = { id: 'm1', active: true, activeAt: Date.now() };

        expect(canCreateNewSession({
            selectedMachineId: null,
            selectedMachine: machine,
            selectedPath: '/repo',
        })).toBe(false);

        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: machine,
            selectedPath: '   ',
        })).toBe(false);
    });

    it('returns false when selected machine is offline', () => {
        const offlineMachine: any = { id: 'm1', active: false, activeAt: 0 };
        expect(canCreateNewSession({
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
            selectedMachineId: 'm-old',
            selectedMachine: replacedMachine,
            selectedPath: '/repo',
        })).toBe(false);
    });

    it('allows offline machines when the authoring flow is saving an automation', () => {
        const offlineMachine: any = { id: 'm1', active: false, activeAt: 0 };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: offlineMachine,
            selectedPath: '/repo',
            allowOfflineMachine: true,
        })).toBe(true);
    });

    it('returns true when selected machine has exact spawn readiness', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
            spawnReadiness: { status: 'ready', machineId: 'm1' },
        })).toBe(true);
    });

    it('allows an online machine to attempt launch before exact spawn readiness resolves', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
        })).toBe(true);
    });

    it('allows an online machine to attempt launch while exact spawn readiness is probing', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
            spawnReadiness: { status: 'probing', machineId: 'm1' },
        })).toBe(true);
    });

    it('blocks launch when exact spawn readiness has a confirmed unavailable status', () => {
        const onlineMachine: any = { id: 'm1', active: true, activeAt: Date.now() };
        expect(canCreateNewSession({
            selectedMachineId: 'm1',
            selectedMachine: onlineMachine,
            selectedPath: '/repo',
            spawnReadiness: { status: 'rpcUnavailable', machineId: 'm1' },
        })).toBe(false);
    });
});
