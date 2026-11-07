import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load the real route graph outside per-interaction budgets, as the picker harness does.
await import('./MachineAddDraftScreen');
await import('./MachineAddForm');
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

    it('opens on Create one in the cloud in a browser, with Create one last on the bar (58d §D2, P-M7 order)', async () => {
        const target = await harness.addHome({ name: 'Build', serverUrl: 'https://creation-on.example', serverIdentityId: 'srv_creation_on', accountId: 'owner' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        const { MachineAddDraftScreen } = await import('./MachineAddDraftScreen');
        const screen = await renderScreen(<MachineAddDraftScreen />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-picker').length).toBeGreaterThan(0));
        // Create one is a way in beside the connection paths, not a second tab layer; it ends the bar.
        const segmentIds = screen.tree.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('settings.machines.draft.form.path:'))
            .map(node => node.props.testID as string).filter((id, index, all) => all.indexOf(id) === index);
        expect(segmentIds.at(-1)).toBe('settings.machines.draft.form.path:create');
        expect(screen.tree.findAll(node => node.props.testID === 'settings.machines.draft.form.mode:create')).toHaveLength(0);
        const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
        expect(readMachineAddFlowDraft().creating).toBe(true);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        // Choosing a connection path leaves Create one.
        await act(async () => screen.pressByTestId('settings.machines.draft.form.path:ssh'));
        expect(screen.tree.findAll(node => node.props.testID === 'managed-picker')).toHaveLength(0);
        expect(readMachineAddFlowDraft().creating).toBe(false);
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
});
