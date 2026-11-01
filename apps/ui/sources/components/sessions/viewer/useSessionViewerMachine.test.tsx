import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storage');
const { useSessionViewerMachine, resolveSessionViewerMachineName } = await import('./useSessionViewerMachine');
const { useSessionComputerScreen } = await import('@/components/computer/useSessionComputerScreen');
const { useOpenSessionComputerScreen } = await import('@/components/computer/useOpenSessionComputerScreen');
const { SessionViewerControllerProvider } = await import('./SessionViewerControllerProvider');
const { useOptionalSessionViewerController } = await import('./SessionViewerController');

const initialStorage = getStorage().getState();
const serverId = 'srv_viewer_machine';

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Viewer Home', serverUrl: 'https://viewer-machine.example.test',
        serverIdentityId: serverId, accountId: 'account' });
});
afterEach(async () => { standardCleanup(); clearMachineRequestReachabilityForTest(); getStorage().setState(initialStorage, true); await home.reset(); });

function seed(machineSeed: Parameters<typeof createMachineFixture>[0] | null) {
    const session = createSessionFixture({ id: 's1', serverId, active: true, metadata: { machineId: 'm1', path: '/repo', host: 'host-1' } });
    const machine = machineSeed ? createMachineFixture({ id: 'm1', activeAt: Date.now(), ...machineSeed }) : null;
    getStorage().setState({
        sessions: { s1: session },
        machines: machine ? { m1: machine } : {},
        machineListByServerId: { [serverId]: machine ? [machine] : [] },
    });
}

describe('the Machine name the viewer says', () => {
    it('keeps an offline Computer launcher disabled and refuses another requested Machine', async () => {
        seed({ active: false, activeAt: Date.now() - 120_000 });
        const openDocked = vi.fn();
        function Wrapper(props: React.PropsWithChildren) {
            return React.createElement(SessionViewerControllerProvider, {
                sessionId: 's1', serverId, phone: false, canPresentSource: () => true, openDocked,
            }, props.children);
        }
        const hook = await renderHook(() => ({
            own: useOpenSessionComputerScreen({ sessionId: 's1', serverId }),
            other: useOpenSessionComputerScreen({ sessionId: 's1', serverId, machineId: 'another-machine' }),
            mode: useOptionalSessionViewerController()?.state.mode,
        }), { wrapper: Wrapper });
        expect(hook.getCurrent().own).not.toBeNull();
        expect(hook.getCurrent().own?.disabledReason).toBeTruthy();
        expect(hook.getCurrent().other).toBeNull();
        await act(async () => { hook.getCurrent().own?.open(); });
        expect(hook.getCurrent().mode).toBe('closed');
        expect(openDocked).not.toHaveBeenCalled();
    });
    it('retains Machine identity without an offline dot while its Home presence is withdrawn', async () => {
        seed({ active: false, activeAt: Date.now() - 120_000 });
        const hook = await renderHook(() => useSessionViewerMachine('s1', serverId, 'computer'));
        expect(hook.getCurrent().online).toBe(false);
        const name = hook.getCurrent().name;
        const scope = { serverId, accountId: 'account' };
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent()).toMatchObject({ name, online: null });
        await act(async () => captureMachinePresenceObservation({ ...scope, accountId: 'another-account' })(['m1']));
        expect(hook.getCurrent().online).toBeNull();
        await act(async () => captureMachinePresenceObservation(scope)(['m1']));
        expect(hook.getCurrent().online).toBe(false);
    });
    it('keeps a hydrating Machine title out of Computer recovery sentences', async () => {
        seed({ metadata: null, availability: undefined });
        const hook = await renderHook(() => ({
            computer: useSessionComputerScreen({ sessionId: 's1', serverId, machineId: 'm1' }),
            viewer: useSessionViewerMachine('s1', serverId, 'computer'),
        }));
        expect(hook.getCurrent().viewer.name).toBe('Loading…');
        expect(hook.getCurrent().computer.machineName).toBeNull();
    });

    it('names a Machine whose details are locked by the same name its presence gives it, so a pane can say it too', async () => {
        seed({ availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
        const hook = await renderHook(() => useSessionViewerMachine('s1', serverId, 'computer'));
        expect(hook.getCurrent().name).toBe('Locked machine');
        expect(resolveSessionViewerMachineName(null, hook.getCurrent().name)).toBe('Locked machine');
    });

    it('prefers the name a source states, and never falls back to the raw Machine id', async () => {
        expect(resolveSessionViewerMachineName(' Studio ', 'Other')).toBe('Studio');
        seed(null);
        const hook = await renderHook(() => useSessionViewerMachine('s1', serverId, 'browser'));
        expect(hook.getCurrent().name).toBe('');
    });
});
