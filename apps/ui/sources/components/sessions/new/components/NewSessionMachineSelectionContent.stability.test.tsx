import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ManagedMachineDestinationProjection } from './machineSelection/managedMachineSelection';
import type { Machine } from '@/sync/domains/state/storageTypes';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
const { storage, useMachineListForServer } = await import('@/sync/domains/state/storage');

beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

describe('New Session open Machine picker publication', () => {
    it('offers managed configuration as a draft command without pool acquisition or favourite commands', async () => {
        const serverId = await home.addHome({ name: 'Studio', serverUrl: 'https://picker-draft.test',
            serverIdentityId: 'srv_picker_draft', accountId: 'owner', currentAccount: true });
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        storage.setState({ profileScope: { serverId, accountId: 'owner' }, settingsScope: { serverId, accountId: 'owner' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        function DraftPicker() {
            const [configured, setConfigured] = React.useState(false);
            return <><span>{String(configured)}</span><NewSessionMachineSelectionContent
                groups={[]} selectedMachine={null} selectedServerId={null} recentMachines={[]} favoriteMachines={[]}
                onSelectMachine={() => {}} onSelectScopedMachine={() => {}} onSelectManagedMachine={() => {}}
                managedMachines={[{ id: 'sandbox-preset', homeId: 'srv_picker_draft', kind: 'preset', title: 'Sandbox preset',
                    onSelect: () => setConfigured(true) }]}
                currentUiContextDraftCommandScope="draft-picker" showSearch={false} /></>;
        }
        const screen = await renderMountedCurrentUiContext(<DraftPicker />);
        const reader = readCurrentUiContextActionReader({ surface: 'agent' })!;
        const commands = reader.readCurrentUiContext()!.commands;
        expect(commands.map(command => command.title)).toEqual(['Sandbox preset', 'Close']);
        const resolved = reader.resolveCurrentUiCommand(commands[0]!.id)!;
        if (resolved.command.kind !== 'hostLocal') throw new Error('Expected draft command');
        await act(async () => { await resolved.command.invoke({ signal: resolved.retirementSignal, context: { surface: 'agent' } }); });
        expect(screen.getTextContent()).toContain('true');
        await screen.unmount();
        expect(reader.resolveCurrentUiCommand(commands[0]!.id)).toBeNull();
    });
    it('settles the real managed-offer projection when its host rerenders with current callbacks', async () => {
        const serverId = await home.addHome({ name: 'Studio', serverUrl: 'https://picker-stability.test',
            serverIdentityId: 'srv_picker_stability', accountId: 'owner', currentAccount: true });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        home.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
        const scope = { serverId, accountId: 'owner' };
        const machine = createMachineFixture({ id: 'studio', active: false });
        storage.setState({ profileScope: scope });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId, sourceAccountId: 'owner' });
        let renders = 0;
        let projection: ManagedMachineDestinationProjection | null = null;
        function PickerHost() {
            // Fail a feedback loop deterministically instead of leaving React's warning loop running.
            if (++renders > 64) throw new Error('Machine picker publication does not settle');
            const [current, setCurrent] = React.useState<ManagedMachineDestinationProjection | null>(null);
            const machines = useMachineListForServer(serverId) ?? [];
            projection = current;
            return <NewSessionMachineSelectionContent<Machine> groups={[{ serverId, serverName: 'Studio', loading: false, signedOut: false,
                machines: machines.map(row => ({ ...row, serverId, serverName: 'Studio' })) }]}
                selectedMachine={null} selectedServerId={serverId}
                recentMachines={[]} favoriteMachines={[]} onSelectMachine={() => {}} onSelectScopedMachine={() => {}}
                onSelectManagedMachine={() => {}} onConfigureManagedMachine={() => {}}
                onManagedMachineProjection={(_serverId, next) => setCurrent(previous =>
                    previous?.state === next.state && previous.rowCount === next.rowCount ? previous : next)} />;
        }
        const screen = await renderScreen(<PickerHost />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(projection).toEqual({ state: 'available', rowCount: 1 });
        });
        await act(async () => storage.getState().applyMachines([{ ...machine }], true,
            { sourceServerId: serverId, sourceAccountId: 'owner' }));
        await flushHookEffects();
        expect(screen.findByTestId('new-session-machine-list')).not.toBeNull();
        await screen.unmount();
    });
});
