import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

// Keep cold production-module loading outside the behavioral test's runner deadline.
// The target owner reaches Machine naming and text; install its boundaries before importing it.
const { resolveMachineAdministrationTargetState } = await import('@/sync/domains/machines/administration/targetSelection');
const { MachineAdministrationTargetSelector: DraftMachineTargetSelector } = await import('./MachineAdministrationTargetSelector');
const { buildTeamCredentialBrokerMachineSelection } = await import('../teams/credentials/teamCredentialBrokerMachineSelection');

function createSelection(availability: MachineAdministrationCandidateV1['availability'] = 'online', observation: 'live' | 'stale' = 'live') {
    const target = { serverIdentityId: 'portable-server-b', machineId: 'machine-b' };
    const candidate: MachineAdministrationCandidateV1 = {
        target, displayName: 'Machine B', serverLabel: 'Server B', availability, observation, observedAt: 100,
    };
    const machine: MachineDisplayRenderable = {
        id: target.machineId, updatedAt: 100, active: availability === 'online',
        activeAt: 100, metadataVersion: 1, metadata: { displayName: 'Machine B', host: 'host-b' },
    };
    const selectTarget = vi.fn();
    const clearTarget = vi.fn();
    const state = resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [candidate] });
    const selection: MachineAdministrationTargetSelectionV1 = {
        candidates: [candidate],
        pickerRows: [{ candidate, serverId: 'local-profile-b', serverName: 'Server B', machine }],
        state,
        selectedTarget: target,
        selectedTargetServerMatchesActiveAccount: false,
        canExecute: state.kind === 'online',
        selectTarget,
        clearTarget,
        resolveExecutionTarget: () => null,
    };
    return { selection, selectTarget, clearTarget };
}

afterEach(clearActiveUnsavedChangesGuard);

describe('MachineAdministrationTargetSelector', () => {
    it.each(['section', 'chip'] as const)('retains shared Machines in an ordinary %s picker', (presentation) => withPopoverWebGlobals(async () => {
        const { selection } = createSelection();
        const sharedSelection: MachineAdministrationTargetSelectionV1 = {
            ...selection,
            pickerRows: selection.pickerRows.map(row => ({ ...row, machine: { ...row.machine, isShared: true,
                access: { custodian: { accountId: 'other-custodian', displayName: 'Other custodian' },
                    role: 'use', resourceMode: 'plain', accessState: 'ready' } } })),
        };
        const screen = await renderScreen(<DraftMachineTargetSelector selection={sharedSelection} presentation={presentation} testIDPrefix="shared.target" />);
        try {
            await screen.pressByTestIdAsync(`shared.target.${presentation === 'chip' ? 'chip' : 'current'}`);
            if (presentation === 'chip') {
                await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
                expect(screen.getTextContent()).toContain('machines.destinations.shared');
            }
            expect(screen.findHostByTestId('shared.target.picker-option:machine-b')).not.toBeNull();
        } finally { await screen.unmount(); }
    }));

    it.each(['section', 'chip'] as const)('omits a domain-hidden Machine from the %s picker while retaining its selected reason', (presentation) => withPopoverWebGlobals(async () => {
        const { selection } = createSelection();
        const ownCandidate: MachineAdministrationCandidateV1 = { ...selection.candidates[0]!,
            target: { serverIdentityId: 'portable-server-b', machineId: 'machine-own' }, displayName: 'Own Machine' };
        const pickerSelection: MachineAdministrationTargetSelectionV1 = {
            ...selection,
            candidates: [...selection.candidates, ownCandidate],
            pickerRows: [...selection.pickerRows, { candidate: ownCandidate, serverId: 'local-profile-b', serverName: 'Server B',
                machine: { ...selection.pickerRows[0]!.machine, id: 'machine-own', metadata: { displayName: 'Own Machine' } } }],
        };
        const screen = await renderScreen(<DraftMachineTargetSelector selection={pickerSelection} presentation={presentation}
            testIDPrefix="hidden.target" resolveCandidateAvailability={candidate => candidate.target.machineId === 'machine-b'
                ? { hidden: true, selectable: false, detail: 'domain-owned selected reason' } : undefined} />);
        try {
            const trigger = `hidden.target.${presentation === 'chip' ? 'chip' : 'current'}`;
            expect(screen.findHostByTestId(trigger)?.props.accessibilityLabel).toContain('domain-owned selected reason');
            await screen.pressByTestIdAsync(trigger);
            if (presentation === 'chip') await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
            expect(screen.findHostByTestId('hidden.target.picker-option:machine-b')).toBeNull();
            expect(screen.findHostByTestId('hidden.target.picker-option:machine-own')).not.toBeNull();
        } finally { await screen.unmount(); }
    }));

    it('does not label an unselected compact scope as an unavailable machine', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection } = createSelection();
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector
                selection={{ ...selection, selectedTarget: null, state: { kind: 'unselected', candidates: selection.candidates } }}
                presentation="context"
                testIDPrefix="context.target"
            />,
        );
        const current = screen.findHostByTestId('context.target.current');
        const label = current?.props.accessibilityLabel ?? current?.props['aria-label'];
        expect(label).not.toContain('common.unavailable');
        expect(current?.props.disabled ?? current?.props.accessibilityState?.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('context.target.current');
        expect(screen.findHostByTestId('context.target.picker-option:machine-b')).not.toBeNull();
    });

    it('labels an unselected header chip as a machine choice, not a session-start instruction', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection } = createSelection();
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector
                selection={{ ...selection, selectedTarget: null, state: { kind: 'unselected', candidates: selection.candidates } }}
                presentation="chip"
                testIDPrefix="header.target"
            />,
        );
        const chip = screen.findHostByTestId('header.target.chip');
        const label = chip?.props.accessibilityLabel ?? chip?.props['aria-label'];
        expect(label).toContain('settingsPlugins.targetSelection.chooseMachine');
        expect(label).not.toContain('newSession.noMachineSelected');
    });

    it('labels an unselected install or administration section as a machine to choose, not a session start or an unavailable machine', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection } = createSelection();
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector
                selection={{ ...selection, selectedTarget: null, state: { kind: 'unselected', candidates: selection.candidates } }}
                presentation="section"
                groupTitle="Install on"
                testIDPrefix="install.target"
            />,
        );
        const current = screen.findHostByTestId('install.target.current');
        const label = String(current?.props.accessibilityLabel ?? current?.props['aria-label'] ?? '');
        expect(label).toContain('settingsPlugins.targetSelection.chooseMachine');
        expect(label).not.toContain('newSession.noMachineSelected');
        expect(label).not.toContain('common.unavailable');
    });

    it('opens the shared machine list from the header chip and keeps the domain availability decision', () => withPopoverWebGlobals(async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const offline = createSelection('offline');
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector
                selection={offline.selection}
                presentation="chip"
                testIDPrefix="header.target"
                resolveCandidateAvailability={(candidate) => candidate.availability === 'offline'
                    ? { detail: 'offline but selectable', selectable: true }
                    : { detail: 'update required', selectable: false }}
            />,
        );
        const option = 'header.target.picker-option:machine-b';
        expect(screen.findHostByTestId('header.target.picker-list')).toBeNull();

        await screen.pressByTestIdAsync('header.target.chip');
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        expect(screen.findHostByTestId('header.target.picker-list')).not.toBeNull();
        const row = screen.findHostByTestId(option);
        expect(row?.props.disabled ?? row?.props.accessibilityState?.disabled ?? row?.props['aria-disabled']).not.toBe(true);
        expect(screen.getTextContent()).toContain('offline but selectable');

        await screen.pressByTestIdAsync(option);
        expect(offline.selectTarget).toHaveBeenCalledWith({ serverIdentityId: 'portable-server-b', machineId: 'machine-b' });
        const chip = screen.findHostByTestId('header.target.chip');
        expect(chip?.props.accessibilityState?.expanded ?? chip?.props['aria-expanded']).toBe(false);
    }));

    it('keeps a domain-offline machine disabled without inventing presence for an unbound Home', () => withPopoverWebGlobals(async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const offline = createSelection('offline');
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={offline.selection} presentation="chip" testIDPrefix="header.target" />,
        );

        await screen.pressByTestIdAsync('header.target.chip');
        const option = 'header.target.picker-option:machine-b';
        const row = screen.findHostByTestId(option);
        expect(row?.props.disabled ?? row?.props.accessibilityState?.disabled ?? row?.props['aria-disabled']).toBe(true);
        // The candidate supplies administration admission, but this fixture has no authenticated
        // Home scope. The shared presence owner must report Unknown rather than infer Offline.
        expect(screen.getTextContent()).toContain('common.unknown');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(screen.getTextContent()).not.toContain('settingsProviders.detail.machineOffline');
        await screen.pressByTestIdAsync(option).catch(() => undefined);
        expect(offline.selectTarget).not.toHaveBeenCalled();
    }));

    it('keeps the same-name distinguishing suffix in the selected chip and its machine choices', () => withPopoverWebGlobals(async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection } = createSelection();
        const hostname = 'NLDW4-5-40-40';
        const pickerRows = ['2cd4-machine', 'ae13-machine'].map((id) => ({
            ...selection.pickerRows[0]!,
            machine: { ...selection.pickerRows[0]!.machine, id, metadata: { displayName: hostname, host: hostname } },
            candidate: { ...selection.candidates[0]!, displayName: hostname, target: { serverIdentityId: 'portable-server-b', machineId: id } },
        }));
        const selectedTarget = pickerRows[0]!.candidate.target;
        const candidates = pickerRows.map((row) => row.candidate);
        const screen = await renderScreen(<MachineAdministrationTargetSelector
            selection={{ ...selection, candidates, pickerRows, selectedTarget,
                state: resolveMachineAdministrationTargetState({ storedTarget: selectedTarget, candidates }) }}
            presentation="chip" testIDPrefix="identity.target"
        />);
        const chip = screen.findHostByTestId('identity.target.chip');
        expect(chip?.props.accessibilityLabel ?? chip?.props['aria-label']).toContain(`${hostname} · 2cd4`);
        await screen.pressByTestIdAsync('identity.target.chip');
        for (const id of ['2cd4-machine', 'ae13-machine']) {
            const row = screen.findHostByTestId(`identity.target.picker-option:${id}`);
            expect(row?.props.accessibilityLabel ?? row?.props['aria-label']).toContain(`${hostname} · ${id.slice(0, 4)}`);
        }
    }));

    it('keeps the compact context readable and reveals clearing beside the machine choices', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, clearTarget } = createSelection('offline');
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} presentation="context" testIDPrefix="context.target" />,
        );
        const current = screen.findHostByTestId('context.target.current');
        const label = current?.props.accessibilityLabel ?? current?.props['aria-label'];
        expect(label).toContain('Machine B');
        expect(label).toContain('Server B');
        expect(label).toContain('settingsProviders.detail.machineOffline');
        expect(label).not.toContain('machine-b');
        expect(screen.findHostByTestId('context.target.clear')).toBeNull();

        await screen.pressByTestIdAsync('context.target.current');
        expect(screen.findHostByTestId('context.target.clear')).not.toBeNull();
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'context-test',
        });
        await screen.pressByTestIdAsync('context.target.clear');
        expect(clearTarget).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('context.target.clear')).not.toBeNull();
        clearActiveUnsavedChangesGuard();
        await screen.pressByTestIdAsync('context.target.clear');
        expect(clearTarget).toHaveBeenCalledOnce();
    });

    it('keeps a missing compact target recoverable when no machines are currently listed', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, clearTarget } = createSelection();
        const missingSelection: MachineAdministrationTargetSelectionV1 = {
            ...selection,
            candidates: [],
            pickerRows: [],
            state: resolveMachineAdministrationTargetState({ storedTarget: selection.selectedTarget, candidates: [] }),
        };
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={missingSelection} presentation="context" testIDPrefix="context.target" />,
        );
        expect(screen.findHostByTestId('context.target.clear')).toBeNull();
        await screen.pressByTestIdAsync('context.target.current');
        await screen.pressByTestIdAsync('context.target.clear');
        expect(clearTarget).toHaveBeenCalledOnce();
    });

    it('opens the real picker on demand and preserves the exact portable target on selection', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget } = createSelection();
        const screen = await renderScreen(<MachineAdministrationTargetSelector selection={selection} testIDPrefix="administration.target" />);
        const option = 'administration.target.picker-option:machine-b';
        expect(screen.findHostByTestId(option)).toBeNull();
        await screen.pressByTestIdAsync('administration.target.current');
        expect(screen.findHostByTestId(option)).not.toBeNull();
        expect(selectTarget).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(option);
        expect(selectTarget).toHaveBeenCalledWith({ serverIdentityId: 'portable-server-b', machineId: 'machine-b' });
        expect(screen.findHostByTestId(option)).toBeNull();
    });

    it('preserves the draft and open picker when the real unsaved-change guard rejects a target change', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget } = createSelection();
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'target-test',
        });
        const screen = await renderScreen(<MachineAdministrationTargetSelector selection={selection} testIDPrefix="administration.target" />);
        await screen.pressByTestIdAsync('administration.target.current');
        await screen.pressByTestIdAsync('administration.target.picker-option:machine-b');
        expect(selectTarget).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('administration.target.picker-option:machine-b')).not.toBeNull();
    });

    it.each(['section', 'chip'] as const)('edits a draft broker through the %s picker without discarding that draft', (presentation) => withPopoverWebGlobals(async () => {
        const { selection } = createSelection();
        const isDirtyRef = { current: true };
        setActiveUnsavedChangesGuard({
            isDirtyRef, requestDecision: async () => 'keepEditing', tag: 'broker-draft',
        });
        function DraftBroker() {
            const [target, setTarget] = React.useState<typeof selection.selectedTarget>(null);
            const broker = buildTeamCredentialBrokerMachineSelection({
                serverId: 'local-profile-b',
                eligibleTargets: [{ machineId: 'machine-b', displayName: null, availability: 'available' }],
                selectedMachineId: target?.machineId ?? null,
                pickerRows: selection.pickerRows,
                onSelectMachineId: () => setTarget(selection.candidates[0]!.target),
                onClear: () => setTarget(null),
            });
            return <DraftMachineTargetSelector
                selection={broker.selection}
                presentation={presentation}
                testIDPrefix="broker.target"
            />;
        }
        const screen = await renderScreen(<DraftBroker />);
        const trigger = `broker.target.${presentation === 'chip' ? 'chip' : 'current'}`;
        await screen.pressByTestIdAsync(trigger);
        if (presentation === 'chip') {
            await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        }
        await screen.pressByTestIdAsync('broker.target.picker-option:machine-b');
        const current = screen.findHostByTestId(trigger);
        expect(current?.props.accessibilityLabel ?? current?.props['aria-label']).toContain('Machine B');
        expect(isDirtyRef.current).toBe(true);
        if (presentation === 'section') {
            await screen.pressByTestIdAsync('broker.target.clear');
            const cleared = screen.findHostByTestId(trigger);
            expect(cleared?.props.accessibilityLabel ?? cleared?.props['aria-label']).not.toContain('Machine B');
            expect(isDirtyRef.current).toBe(true);
        }
    }));

    it.each(['offline', 'locked', 'missing', 'replaced', 'revoked'] as const)('keeps the %s target visible and unavailable in the real picker', async (availability) => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget, clearTarget } = createSelection(availability);
        const screen = await renderScreen(<MachineAdministrationTargetSelector selection={selection} testIDPrefix="administration.target" />);
        const current = screen.findHostByTestId('administration.target.current');
        expect(current?.props.accessibilityLabel ?? current?.props['aria-label']).toContain('Machine B');
        const reason = availability === 'offline' ? 'settingsProviders.detail.machineOffline' : 'settingsPlugins.targetSelection.' + availability;
        expect(current?.props.accessibilityLabel ?? current?.props['aria-label']).toContain(reason);
        await screen.pressByTestIdAsync('administration.target.current');
        const option = screen.findHostByTestId('administration.target.picker-option:machine-b');
        expect(option?.props.disabled ?? option?.props.accessibilityState?.disabled ?? option?.props['aria-disabled']).toBe(true);
        expect(selectTarget).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('administration.target.clear');
        expect(clearTarget).toHaveBeenCalledOnce();
        expect(selectTarget).not.toHaveBeenCalled();
    });

    it('does not allow a stale online snapshot to become an execution target', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget } = createSelection('online', 'stale');
        const screen = await renderScreen(<MachineAdministrationTargetSelector selection={selection} testIDPrefix="administration.target" />);
        await screen.pressByTestIdAsync('administration.target.current');
        const option = screen.findHostByTestId('administration.target.picker-option:machine-b');
        expect(option?.props.disabled ?? option?.props.accessibilityState?.disabled ?? option?.props['aria-disabled']).toBe(true);
        expect(selectTarget).not.toHaveBeenCalled();
    });

    it('lets a consuming domain keep an offline eligible machine selectable while disabling update-required with its reason', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const offline = createSelection('offline');
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector
                selection={offline.selection}
                testIDPrefix="broker.target"
                resolveCandidateAvailability={(candidate) => candidate.availability === 'offline'
                    ? { detail: 'offline but selectable', selectable: true }
                    : { detail: 'update required', selectable: false }}
                resolveCandidatePresentation={() => ({ title: 'Safe machine name', subtitle: 'Server B' })}
            />,
        );

        await screen.pressByTestIdAsync('broker.target.current');
        const option = screen.findHostByTestId('broker.target.picker-option:machine-b');
        expect(option?.props.disabled ?? option?.props.accessibilityState?.disabled).not.toBe(true);
        expect(`${String(option?.props.title)} ${String(option?.props.subtitle)}`).not.toContain('machine-b');
        await screen.pressByTestIdAsync('broker.target.picker-option:machine-b');
        expect(offline.selectTarget).toHaveBeenCalledWith({ serverIdentityId: 'portable-server-b', machineId: 'machine-b' });
    });

    it('closes a controlled picker without changing the selected draft', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget } = createSelection();
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} testIDPrefix="broker.target" />,
        );

        await screen.pressByTestIdAsync('broker.target.current');
        expect(screen.findHostByTestId('broker.target.picker-option:machine-b')).not.toBeNull();
        await screen.pressByTestIdAsync('broker.target.current');
        expect(screen.findHostByTestId('broker.target.picker-option:machine-b')).toBeNull();
        expect(selectTarget).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('broker.target.current')?.props.accessibilityLabel).toContain('Machine B');
    });

    it('never shows opaque ids: a missing target names its Home and offers another machine', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const fixture = createSelection();
        const target = fixture.selection.selectedTarget!;
        const selection: MachineAdministrationTargetSelectionV1 = {
            ...fixture.selection,
            // A read machine list that lacks the saved machine.
            state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [], isInventoryKnown: () => true }),
        };
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} testIDPrefix="section.target" />,
        );

        const current = screen.findHostByTestId('section.target.current');
        const presentation = `${String(current?.props.title)} ${String(current?.props.subtitle)} ${String(current?.props.accessibilityLabel)}`;
        // No saved Home profile resolves this identity in the test, so the Home is "this Home".
        expect(presentation).toContain('settingsPlugins.targetSelection.missingInThisHome');
        expect(screen.getTextContent()).toContain('settingsPlugins.targetSelection.chooseAnother');
        expect(presentation).not.toContain(target.machineId);
        expect(presentation).not.toContain(target.serverIdentityId);
    });

    it('shows loading while a saved target\'s Home inventory is unread', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const fixture = createSelection();
        const target = fixture.selection.selectedTarget!;
        const selection: MachineAdministrationTargetSelectionV1 = {
            ...fixture.selection,
            state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [], isInventoryKnown: () => false }),
        };
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} testIDPrefix="section.target" />,
        );

        const current = screen.findHostByTestId('section.target.current');
        const presentation = `${String(current?.props.title)} ${String(current?.props.subtitle)} ${String(current?.props.accessibilityLabel)}`;
        expect(presentation).toContain('common.loading');
        expect(presentation).not.toContain('settingsPlugins.targetSelection.unreachableThisHome');
        expect(presentation).not.toContain('settingsPlugins.targetSelection.missingInThisHome');
        expect(presentation).not.toContain(target.machineId);
    });

    it.each(['error', 'signedOut'] as const)('preserves an inventory %s without declaring its Home unreachable', async (inventoryStatus) => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const fixture = createSelection();
        const target = fixture.selection.selectedTarget!;
        const selection: MachineAdministrationTargetSelectionV1 = {
            ...fixture.selection,
            state: resolveMachineAdministrationTargetState({
                storedTarget: target, candidates: [],
                readInventoryStatus: () => inventoryStatus,
            }),
        };
        const screen = await renderScreen(<MachineAdministrationTargetSelector selection={selection} testIDPrefix="section.target" />);
        const current = screen.findHostByTestId('section.target.current');
        const label = String(current?.props.accessibilityLabel);
        expect(label).toContain(inventoryStatus === 'signedOut' ? 'server.signedOut' : 'common.unavailable');
        expect(label).not.toContain('common.loading');
        expect(label).not.toContain('unreachable');
    });

    it('never shows a live target machine id beside its Home', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection } = createSelection('offline');
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} testIDPrefix="section.target" />,
        );

        const current = screen.findHostByTestId('section.target.current');
        const presentation = `${String(current?.props.title)} ${String(current?.props.subtitle)} ${String(current?.props.accessibilityLabel)}`;
        expect(presentation).toContain('Machine B');
        expect(presentation).toContain('Server B');
        expect(presentation).not.toContain('machine-b');
        expect(presentation).not.toContain('portable-server-b');
    });

    it('names a machine without a display name instead of showing its id', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const fixture = createSelection('offline');
        const target = fixture.selection.selectedTarget!;
        const unnamed = { ...fixture.selection.candidates[0]!, displayName: target.machineId };
        const selection: MachineAdministrationTargetSelectionV1 = {
            ...fixture.selection,
            candidates: [unnamed],
            state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [unnamed] }),
        };
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} presentation="chip" testIDPrefix="chip.target" />,
        );

        const chip = screen.findHostByTestId('chip.target.chip');
        const label = String(chip?.props.accessibilityLabel ?? chip?.props['aria-label']);
        expect(label).toContain('machine.unnamedMachine');
        expect(label).not.toContain(target.machineId);
    });

    it('names a machine whose details cannot be read as locked, not unnamed and never its id', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const fixture = createSelection('offline');
        const target = fixture.selection.selectedTarget!;
        const unnamed = { ...fixture.selection.candidates[0]!, displayName: target.machineId, availability: 'locked' as const };
        const selection: MachineAdministrationTargetSelectionV1 = {
            ...fixture.selection,
            candidates: [unnamed],
            state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [unnamed] }),
        };
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector selection={selection} presentation="chip" testIDPrefix="chip.target" />,
        );

        const chip = screen.findHostByTestId('chip.target.chip');
        const label = String(chip?.props.accessibilityLabel ?? chip?.props['aria-label']);
        expect(label).toContain('machine.lockedMachine');
        expect(label).not.toContain(target.machineId);
    });

    it('lets a consuming domain suppress opaque ids for a selected target missing from canonical inventory', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const fixture = createSelection();
        const target = fixture.selection.selectedTarget!;
        const selection: MachineAdministrationTargetSelectionV1 = {
            ...fixture.selection,
            candidates: [],
            pickerRows: [],
            // A read machine list that lacks the saved machine.
            state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [], isInventoryKnown: () => true }),
        };
        const screen = await renderScreen(
            <MachineAdministrationTargetSelector
                selection={selection}
                testIDPrefix="broker.target"
                missingTargetTitle="Unavailable Machine"
                missingTargetSubtitle={null}
            />,
        );

        const current = screen.findHostByTestId('broker.target.current');
        const presentation = `${String(current?.props.title)} ${String(current?.props.subtitle)} ${String(current?.props.accessibilityLabel)}`;
        expect(presentation).toContain('Unavailable Machine');
        expect(presentation).not.toContain(target.machineId);
        expect(presentation).not.toContain(target.serverIdentityId);
    });
});
