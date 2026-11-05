import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
beforeEach(async () => { await harness.reset(); });
afterEach(async () => { const { discardMachineAdd } = await import('./useMachineAddFlow'); await act(async () => discardMachineAdd()); standardCleanup(); });

describe('Add machine Connect and Create entry', () => {
    it('hides Create for the addressed Account while keeping connection paths available', async () => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://creation-disabled.example', serverIdentityId: 'srv_creation_off', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 } });
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const screen = await renderScreen(<MachineAddDraftScreen />);
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:create')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:ssh').length).toBeGreaterThan(0);
        expect(harness.requests.some(request => request.path.includes('machines.provisioners'))).toBe(false);
        await screen.unmount();
    });

    it('keeps creation reads asleep until the person opens Create', async () => {
        await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner' });
        const { MachineAddForm } = await import('./MachineAddForm');
        const screen = await renderScreen(<MachineAddForm layout="page" canCreate testID="settings.machines.draft.form" onClose={() => {}} onStartSession={() => {}} />);
        expect(harness.requests.some(request => request.path.includes('machines.provisioners'))).toBe(false);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:create').length).toBeGreaterThan(0));
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:create'));
        expect(screen.tree.findAll(node => node.props.testID === 'managed-picker').length).toBeGreaterThan(0);
        // Create one is a fourth way to add, not a second tab layer, and the rail's draft says what is happening.
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.mode:create')).toHaveLength(0);
        // The add flow owner records it, so the rail's draft row stops saying it is waiting to connect.
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        expect(readMachineAddFlowDraft().creating).toBe(true);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });

    it('watches for an SSH machine only once its command is on screen, and says one waiting line for a pairing link', async () => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://watch-line.example', serverIdentityId: 'srv_watch_line', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><MachineAddDraftScreen /></InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:ssh').length).toBeGreaterThan(0));
        const watchLines = () => screen.tree.findAll(node => typeof node.props.testID === 'string' && node.props.testID.endsWith('.watch'));
        // An empty SSH form has no command to run yet, so nothing can be on its way.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:ssh'));
        await flushHookEffects({ cycles: 5 });
        expect(readMachineAddFlowDraft().startedAtMs).toBeNull();
        expect(watchLines()).toHaveLength(0);
        // The pairing panel carries its own waiting line; arrival is still watched behind it.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:anotherComputer'));
        await flushHookEffects({ cycles: 5 });
        expect(readMachineAddFlowDraft().startedAtMs).not.toBeNull();
        expect(watchLines()).toHaveLength(0);
        await screen.unmount();
    });

    it('groups the ways in as Connect | Create on a phone, with the connection paths under Connect', async () => {
        // Dimensions is the window authority; useWindowDimensions and the presentation readers follow it.
        vi.spyOn((await import('react-native')).Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        await harness.addHome({ name: 'Build', serverUrl: 'https://build-phone.example', serverIdentityId: 'srv_build_phone', accountId: 'owner' });
        const { MachineAddForm } = await import('./MachineAddForm');
        const screen = await renderScreen(<MachineAddForm layout="page" canCreate testID="settings.machines.draft.form" onClose={() => {}} onStartSession={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.path:create').length).toBeGreaterThan(0));
        const segments = (id: string) => screen.tree.findAll(node => node.props.testID === `settings.machines.draft.form.path:${id}`).length;
        // Two segments at phone width (lab m-add Ap), not one per path.
        expect(segments('connect')).toBeGreaterThan(0);
        expect(segments('ssh')).toBe(0);
        expect(segments('anotherComputer')).toBe(0);
        // Every connection path stays one press away under Connect.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.connectPath.ssh'));
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        expect(readMachineAddFlowDraft().path).toBe('ssh');
        expect(readMachineAddFlowDraft().creating).toBe(false);
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:create'));
        expect(readMachineAddFlowDraft().creating).toBe(true);
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.connectPath.ssh')).toHaveLength(0);
        await screen.unmount();
    });
});
