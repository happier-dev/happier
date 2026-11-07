import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { SelectionList } from '@/components/ui/selectionList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';

installNewSessionComponentsCommonModuleMocks();

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
beforeEach(async () => { home = await createPlainArtifactHomeFixture('https://machine-selector.test'); });
afterEach(async () => { await home?.dispose(); home = undefined; });
const { MachineSelector } = await import('./MachineSelector');

function machine(id: string, active: boolean): Machine {
    return { id, seq: 1, createdAt: 1, updatedAt: 1, active, activeAt: active ? Date.now() : 0,
        metadata: { host: id, platform: 'linux', happyCliVersion: '1', happyHomeDir: '/home/test/.happier', homeDir: '/home/test', displayName: id },
        metadataVersion: 1, daemonState: null, daemonStateVersion: 1 };
}

describe('MachineSelector', () => {
    it('folds offline-only workflow destinations through the real list model, while keeping locked rows named', async () => {
        const online = machine('online', true);
        const offline = [machine('studio', false), machine('server', false)];
        const locked: Machine = { ...machine('locked', false), availability: { kind: 'locked', reason: 'recipient_key_pending' } };
        const screen = await renderScreen(<MachineSelector purpose="workflow" machines={[online, ...offline, locked]}
            selectedMachine={null} onSelect={() => {}} showFavorites={false} showRecent={false} showSearch={false}
            showCliGlyphs={false} testIdPrefix="targets" />);
        const options = () => (screen.tree.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>)
            .rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(options().map(option => option.id)).toEqual(['online', 'locked', 'offline:all']);
        const fold = options().find(option => option.id === 'offline:all')!;
        expect(fold.label).toBe(t('projectWorkers.offlineMachines', { count: 2 }));
        await act(async () => { fold.onSelect?.(); });
        expect(options().map(option => option.id)).toEqual(['online', 'locked', 'offline:all', 'studio', 'server']);
        expect(options().filter(option => offline.some(machine => machine.id === option.id)).every(option => option.disabled)).toBe(true);
    });
    // Owner ruling 2026-11-03 permits shared workflow destinations.
    it.each(['list', 'dropdown'] as const)('admits shared workflow destinations in the %s activation path', async (presentation) => {
        const shared: Machine = { ...machine('shared', true), isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
            resourceMode: 'plain', accessState: 'ready',
        } };
        const onSelect = vi.fn();
        const screen = await renderScreen(<MachineSelector purpose="workflow" machines={[shared]} selectedMachine={null}
            presentation={presentation} onSelect={onSelect} showCliGlyphs={false} />);
        if (presentation === 'dropdown') {
            const props = screen.tree.findByType(DropdownMenu).props as React.ComponentProps<typeof DropdownMenu>;
            expect(props.items[0]?.disabled).not.toBe(true);
            await act(async () => { props.onSelect(shared.id); });
        } else {
            const props = screen.tree.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>;
            const option = props.rootStep.sections.flatMap((section) => section.kind === 'static' ? section.options : [])[0];
            expect(option?.disabled).not.toBe(true);
            await act(async () => { option?.onSelect?.(); });
        }
        expect(onSelect).toHaveBeenCalledWith(shared);
    });
    it.each([
        { presentation: 'dropdown', wakeState: 'asleep' },
        { presentation: 'dropdown', wakeState: 'starting' },
        { presentation: 'list', wakeState: 'asleep' },
        { presentation: 'list', wakeState: 'starting' },
    ] as const)('selects an admitted shared $wakeState Session from the $presentation', async ({ presentation, wakeState }) => {
        const shared: Machine = { ...machine('shared', false), isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
            resourceMode: 'plain', accessState: 'ready',
        }, managedInputRuntime: { nativeReady: false, wakeState, newSessionWake: { kind: 'available' } } };
        const onSelect = vi.fn();
        const screen = await renderScreen(<MachineSelector machines={[shared]} selectedMachine={null}
            presentation={presentation} onSelect={onSelect} showCliGlyphs={false} />);
        const wakeReason = wakeState === 'asleep' ? t('managedWake.startsOnSend') : t('managedWake.starting', { machine: 'shared' });
        if (presentation === 'dropdown') {
            const props = screen.tree.findByType(DropdownMenu).props as React.ComponentProps<typeof DropdownMenu>;
            expect(props.items[0]?.disabled).toBe(false);
            expect(props.items[0]?.subtitle).toContain(wakeReason);
            await act(async () => { props.onSelect(shared.id); });
        } else {
            const props = screen.tree.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>;
            const option = props.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
                .find(option => option.id === shared.id);
            expect(option?.disabled).toBe(false);
            expect(option?.subtitle).toContain(wakeReason);
            await act(async () => { option?.onSelect?.(); });
        }
        expect(onSelect).toHaveBeenCalledWith(shared);
    });
    it('names machines, not commands, when the dropdown has none to offer', async () => {
        const screen = await renderScreen(<MachineSelector machines={[]} selectedMachine={null}
            presentation="dropdown" onSelect={vi.fn()} showCliGlyphs={false} noItemsMessage="No machines available" />);
        const props = screen.tree.findByType(DropdownMenu).props as React.ComponentProps<typeof DropdownMenu>;
        expect(props.emptyLabel).toBe('No machines available');
    });
    it('preserves the selected-machine dropdown trigger and offline activation guard', async () => {
        const online = machine('online', true);
        const offline = machine('offline', false);
        const onSelect = vi.fn();
        const screen = await renderScreen(<MachineSelector machines={[online, offline]} selectedMachine={online}
            presentation="dropdown" onSelect={onSelect} showCliGlyphs={false} dropdownTitle="Select computer" dropdownTestID="machine-dropdown" />);
        const dropdown = screen.tree.findByType(DropdownMenu);
        // React's test renderer erases the props type of the actual component above.
        const props = dropdown.props as React.ComponentProps<typeof DropdownMenu>;
        expect(props.itemTrigger).toMatchObject({ title: 'Select computer', subtitle: 'online', itemProps: { testID: 'machine-dropdown' } });
        await act(async () => { props.onSelect('offline'); });
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => { props.onSelect('online'); });
        expect(onSelect.mock.calls[0]?.[0]).toBe(online);
    });
    it('uses the canonical list and preserves original machine identity while rejecting offline activation', async () => {
        const online = machine('online', true);
        const offline = machine('offline', false);
        const onSelect = vi.fn();
        const screen = await renderScreen(<MachineSelector machines={[online, offline]} selectedMachine={null}
            recentMachines={[online]} favoriteMachines={[online]} onSelect={onSelect} showCliGlyphs={false} testIdPrefix="machine" />);
        const list = screen.tree.findByType(SelectionList);
        // React's test renderer erases the props type of the actual component above.
        const props = list.props as React.ComponentProps<typeof SelectionList>;
        const options = props.rootStep.sections.flatMap((section) => section.kind === 'static' ? section.options : []);
        expect(options.map((option) => option.id)).toEqual(['online', 'offline']);
        expect(options.find((option) => option.id === 'offline')?.disabled).toBe(true);
        await act(async () => { options.find((option) => option.id === 'offline')?.onSelect?.(); });
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => { options.find((option) => option.id === 'online')?.onSelect?.(); });
        expect(onSelect.mock.calls[0]?.[0]).toBe(online);
    });
});
