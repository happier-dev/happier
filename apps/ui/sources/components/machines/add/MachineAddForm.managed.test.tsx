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
});
