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
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { buildServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

installNewSessionComponentsCommonModuleMocks();
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
beforeEach(async () => { home = await createPlainArtifactHomeFixture('https://machine-selector.test', { currentAccount: true, accountId: 'machine-selector-account' }); });
afterEach(async () => { await home?.dispose(); home = undefined; });
const { MachineSelector: MachineSelectorOwner } = await import('./MachineSelector');
const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
function MachineSelector(props: React.ComponentProps<typeof MachineSelectorOwner>) {
    return <MachineSelectorOwner serverId={home!.home.id} {...props} />;
}

async function renderMachineSelector(element: React.ReactElement<React.ComponentProps<typeof MachineSelector>>, page = false) {
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { linkMachineActivity } = await import('@/sync/domains/machines/machineActivity');
    const scope = { serverId: home!.home.id, accountId: 'machine-selector-account' };
    await act(async () => {
        await publishMachineInventoryForTest(scope, element.props.machines);
        for (const machine of element.props.machines) {
            const admitted = storage.getState().machineRecordsByServerId[scope.serverId]?.[machine.id];
            if (!admitted) throw new Error('Expected an admitted Machine fixture');
            linkMachineActivity(admitted, machine);
        }
    });
    return renderScreen(page ? <ListPresentationProvider value="page">{element}</ListPresentationProvider> : element);
}

function machine(id: string, active: boolean): Machine {
    return { id, seq: 1, createdAt: 1, updatedAt: 1, active, activeAt: active ? Date.now() : 0,
        metadata: { host: id, platform: 'linux', happyCliVersion: '1', happyHomeDir: '/home/test/.happier', homeDir: '/home/test', displayName: id },
        metadataVersion: 1, daemonState: null, daemonStateVersion: 1 };
}

describe('MachineSelector', () => {
    it.each(['owned', 'shared'] as const)('keeps the selected %s offline Machine on the open and closed trigger while its fold stays closed', async ownership => {
        const owned = [machine('Studio desktop', false), machine('Build desktop', false)];
        const shared = ['Shared workstation', 'Shared runner'].map(id => ({ ...machine(id, false), isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const,
        } }));
        const selected = (ownership === 'owned' ? owned : shared)[0]!;
        const screen = await renderMachineSelector(<MachineSelector machines={[...owned, ...shared]} selectedMachine={selected}
            presentation="dropdown" disableOfflineMachines={false} onSelect={vi.fn()} showCliGlyphs={false}
            showFavorites={false} showRecent={false} dropdownTestID="selected-trigger" />, true);
        const triggerTexts = () => screen.findByTestId('selected-trigger').findAll(node => node.type === 'Text')
            .flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []);
        expect(triggerTexts()).toContain(selected.id);
        expect(triggerTexts()).not.toContain(t('common.choose'));
        await screen.pressByTestIdAsync('selected-trigger');
        await vi.waitFor(() => expect(screen.findAllByType(SelectionList)).toHaveLength(1));
        const list = screen.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>;
        expect(list.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options.map(option => option.id) : []))
            .toEqual(['offline:all', 'offline:shared:alice']);
        expect(triggerTexts()).toContain(selected.id);
        expect(triggerTexts()).not.toContain(t('common.choose'));
        await act(async () => screen.findByType(DropdownMenu).props.onOpenChange(false));
        expect(triggerTexts()).toContain(selected.id);
        expect(triggerTexts()).not.toContain(t('common.choose'));
    });

    it('keeps own and shared destinations named while Team defaults and New Session apply their availability', async () => {
        const shared = (id: string, displayName: string | null, active: boolean, custodianId = id): Machine => ({ ...machine(id, active), isShared: true,
            access: { custodian: { accountId: custodianId, displayName }, role: 'use', resourceMode: 'plain', accessState: 'ready' } });
        const machines = [shared('c', 'qa-c', false), shared('c-runner', 'qa-c', false, 'c'),
            machine('owned', true), shared('unknown', null, true), shared('b', 'QA TH B', true)];
        const screen = await renderMachineSelector(<MachineSelector machines={machines} selectedMachine={null}
            presentation="dropdown" disableOfflineMachines={false} onSelect={vi.fn()} showCliGlyphs={false}
            showFavorites={false} showRecent={false} />);
        await act(async () => screen.findByType(DropdownMenu).props.onOpenChange(true));
        const teamSections = (screen.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>).rootStep.sections;
        const serverId = home!.home.id;
        const session = await renderScreen(<NewSessionMachineSelectionContent groups={[{ serverId, serverName: 'Home', loading: false,
            signedOut: false, machines: machines.map(row => buildServerScopedMachine(row, { serverId, serverName: 'Home' })) }]}
            selectedMachine={null} selectedServerId={serverId} onSelectMachine={() => {}} onSelectScopedMachine={() => {}}
            recentMachines={[]} favoriteMachines={[]}
            showCliGlyphs={false} showFavorites={false} showRecent={false} />);
        const sessionSections = (session.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>).rootStep.sections;
        expect(teamSections.map(section => section.id)).toEqual(['all', 'shared:', 'shared:b', 'shared:c']);
        expect(teamSections.map(section => section.id)).toEqual(sessionSections.map(section => section.id));
        const sections = (target: typeof screen) => (target.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>).rootStep.sections;
        const summarize = (rows: typeof teamSections) => rows.flatMap(section => section.kind === 'static' ? [{
            id: section.id, title: section.title, options: section.options.map(option => option.id),
        }] : []);
        expect(summarize(teamSections)).toEqual(summarize(sessionSections));
        for (const target of [screen, session]) {
            const fold = sections(target).flatMap(section => section.kind === 'static' ? section.options : [])
                .find(option => option.id === 'offline:shared:c');
            expect(fold).toBeDefined();
            await act(async () => fold?.onSelect?.());
        }
        expect(summarize(sections(screen))).toEqual(summarize(sections(session)));
        const offlineRow = (target: typeof screen) => sections(target).flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'c');
        expect(offlineRow(screen)?.disabled).toBe(false);
        expect(offlineRow(session)?.disabled).toBe(true);
    });

    it.each(['list', 'dropdown'] as const)('offers own and shared offline defaults equally in %s', async presentation => {
        const owned = machine('owned', false);
        const shared: Machine = { ...machine('shared', false), isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } };
        const onSelect = vi.fn();
        const screen = await renderMachineSelector(<MachineSelector machines={[owned, shared]} selectedMachine={null}
            presentation={presentation} disableOfflineMachines={false} onSelect={onSelect} showCliGlyphs={false}
            showFavorites={false} showRecent={false} testIdPrefix="defaults" />);
        if (presentation === 'dropdown') {
            const props = screen.tree.findByType(DropdownMenu).props as React.ComponentProps<typeof DropdownMenu>;
            expect(props.items.map(row => row.disabled)).toEqual([false, false]);
            expect(props.items[0]?.category).toBe(t('machines.destinations.yours'));
            await act(async () => { props.onOpenChange(true); });
        } else {
            const props = screen.tree.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>;
            const rows = props.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
            expect(rows.map(row => row.disabled)).toEqual([false, false]);
        }
        const optionHosts = screen.findAll(node => typeof node.type === 'string' && (
            node.props.testID === 'defaults-option:owned' || node.props.testID === 'defaults-option:shared'));
        expect(optionHosts.map(node => ({ id: node.props.testID, role: node.props.role })))
            .toEqual([{ id: 'defaults-option:owned', role: 'option' }, { id: 'defaults-option:shared', role: 'option' }]);
        await screen.pressByTestIdAsync('defaults-option:shared');
        expect(onSelect).toHaveBeenCalledWith(shared);
        if (presentation === 'dropdown') expect(screen.tree.findByType(DropdownMenu).props.open).toBe(false);
    });
    it('folds the dropdown through the same list owner at account scale', async () => {
        const screen = await renderMachineSelector(<MachineSelector machines={[machine('online', true),
            ...Array.from({ length: 230 }, (_, index) => machine(`offline-${index}`, false))]}
            selectedMachine={null} presentation="dropdown" onSelect={vi.fn()} showCliGlyphs={false}
            showFavorites={false} showRecent={false} />);
        await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
        const list = screen.tree.findByType(SelectionList);
        const rows = () => (list.props as React.ComponentProps<typeof SelectionList>).rootStep.sections
            .flatMap(section => section.kind === 'static' ? section.options : []);
        expect(rows().map(row => row.id)).toEqual(['online', 'offline:all']);
        await act(async () => { rows()[1]?.onSelect?.(); });
        expect(rows()).toHaveLength(232);
    });
    it.each(['list', 'dropdown'] as const)('expands only the pressed offline section in place in %s', async presentation => {
        const owned = Array.from({ length: 223 }, (_, index) => machine(`owned-offline-${index}`, false));
        const shared = ['shared-a', 'shared-b'].map(id => ({ ...machine(id, false), isShared: true, access: {
            custodian: { accountId: 'qa-c', displayName: 'QA C' }, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const,
        } }));
        const screen = await renderMachineSelector(<MachineSelector machines={[...owned, ...shared]} selectedMachine={null}
            presentation={presentation} disableOfflineMachines={false} onSelect={vi.fn()} showCliGlyphs={false}
            showFavorites={false} showRecent={false} showSearch={false} testIdPrefix="folds" />);
        if (presentation === 'dropdown') {
            await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
        }
        const visibleRows = () => screen.findAll(node => typeof node.type === 'string' && node.props.role === 'option');
        const before = visibleRows();
        expect(before).toHaveLength(2);
        const pressed = before[1]!;
        const pressedId = pressed.props.testID as string;
        const precedingIds = before.slice(0, 1).map(row => row.props.testID);
        await screen.pressByTestIdAsync(pressedId);
        const sections = (screen.tree.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>).rootStep.sections;
        const ownSection = sections.find(section => section.id === 'all');
        expect(ownSection?.kind === 'static' ? ownSection.options.map(option => option.id) : []).toEqual(['offline:all']);
        const expanded = visibleRows();
        // No rows are inserted above the pressed disclosure, so it remains mounted at its position.
        expect(expanded.slice(0, 1).map(row => row.props.testID)).toEqual(precedingIds);
        expect(expanded[1]).toBe(pressed);
        expect(expanded.map(row => row.props.testID)).toEqual([
            ...precedingIds, pressedId, 'folds-option:shared-a', 'folds-option:shared-b',
        ]);
        expect(screen.findAllHostsByTestId('folds-option:owned-offline-0')).toHaveLength(0);
        await screen.pressByTestIdAsync(pressedId);
        expect(visibleRows().map(row => row.props.testID)).toEqual(before.map(row => row.props.testID));
    });
    it('folds offline-only workflow destinations through the real list model, while keeping locked rows named', async () => {
        const online = machine('online', true);
        const offline = [machine('studio', false), machine('server', false)];
        const locked: Machine = { ...machine('locked', false), availability: { kind: 'locked', reason: 'recipient_key_pending' } };
        const screen = await renderMachineSelector(<MachineSelector purpose="workflow" machines={[online, ...offline, locked]}
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
        const screen = await renderMachineSelector(<MachineSelector purpose="workflow" machines={[shared]} selectedMachine={null}
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
        const screen = await renderMachineSelector(<MachineSelector machines={[shared]} selectedMachine={null}
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
        const screen = await renderMachineSelector(<MachineSelector machines={[]} selectedMachine={null}
            presentation="dropdown" onSelect={vi.fn()} showCliGlyphs={false} noItemsMessage="No machines available" />);
        const props = screen.tree.findByType(DropdownMenu).props as React.ComponentProps<typeof DropdownMenu>;
        expect(props.emptyLabel).toBe('No machines available');
    });
    it('preserves the selected-machine dropdown trigger and offline activation guard', async () => {
        const online = machine('online', true);
        const offline = machine('offline', false);
        const onSelect = vi.fn();
        const screen = await renderMachineSelector(<MachineSelector machines={[online, offline]} selectedMachine={online}
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
        const screen = await renderMachineSelector(<MachineSelector machines={[online, offline]} selectedMachine={null}
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
