import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Switch } from '@/components/ui/forms/Switch';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

installMachinesSettingsCommonModuleMocks();

const docker = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' };
const DIRECTLY: MachineIsolationPolicyV1 = { configuredSandboxes: {}, workKinds: {
    sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } };
const CONFIGURED: MachineIsolationPolicyV1 = {
    configuredSandboxes: { node: { provisioner: docker, presetId: 'node-22' }, py: { provisioner: docker, presetId: 'py' } },
    workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'fresh' },
        botsChannels: { kind: 'sandbox', configuredSandboxId: 'py', lifecycle: 'shared-kept' }, automationsWorkflows: { kind: 'directly' } },
};
const ENTRIES = [{ id: 'node', name: 'Node 22', supportsAgentNativeSandbox: true }, { id: 'py', name: 'Python 3.12', supportsAgentNativeSandbox: false }];

async function render(overrides: Record<string, unknown> = {}) {
    const { MachineIsolationPageView } = await import('./MachineIsolationPageView');
    const handlers = { onChooseTarget: vi.fn(), onChooseLifecycle: vi.fn(), onToggleNative: vi.fn(), onRemove: vi.fn() };
    const screen = await renderScreen(React.createElement(MachineIsolationPageView, {
        machineName: 'devbox', status: 'ready', policy: DIRECTLY, entries: [], readOnlyReason: null, busy: false,
        saveFailure: null, checkFailure: null, ...handlers, ...overrides,
    } as never));
    const target = (kind: string) => findTestInstanceByTypeWithProps(screen, ValueFieldSelect, { testID: `machine-isolation-target-${kind}` })?.props;
    const lifecycle = (kind: string) => findTestInstanceByTypeWithProps(screen, SegmentedTabBar, { testIDPrefix: `machine-isolation-lifecycle-${kind}` })?.props;
    const native = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-isolation-native' })?.props;
    return { screen, handlers, target, lifecycle, native, nativeSwitch: native?.rightElement.props as React.ComponentProps<typeof Switch> };
}

describe('Machine isolation page', () => {
    it('lists the added sandbox types in the preset table, with the image’s next step and Remove in each row’s “…”', async () => {
        const failed = { id: 'node-22', name: 'Node 22', owner: { kind: 'account' }, preparation: { enabled: true },
            prepared: { status: 'failed' } };
        const { screen, handlers } = await render({ policy: CONFIGURED, entries: [
            { id: 'node', name: 'Node 22', supportsAgentNativeSandbox: true, preset: failed, serverId: 'srv' },
            { id: 'py', name: 'Python 3.12', supportsAgentNativeSandbox: null, missingType: true, preset: null, serverId: 'srv' },
        ] });
        // The image says it failed, and its one next step stands beside it; the healthy-or-unknown row carries none.
        expect(screen.root.findAll(node => node.props.testID === 'preset-table.next.node').length).toBeGreaterThan(0);
        expect(screen.root.findAll(node => node.props.testID === 'preset-table.next.py')).toHaveLength(0);
        const text = screen.root.findAll(node => typeof node.props.children === 'string').map(node => node.props.children as string);
        expect(text).toContain('machineDetailPage.isolation.sandboxes.missingType');
        // The failed image's Retry is reachable from its row's "…" at every width, before Remove.
        const nodeMenu = screen.root.findAll(node => Array.isArray(node.props.secondaryActions)
            && node.props.secondaryActions[0]?.id === 'retry');
        expect(nodeMenu.length).toBeGreaterThan(0);
        expect(nodeMenu[0]!.props.secondaryActions.map((action: { id: string }) => action.id)).toEqual(['retry', 'remove']);
        // Remove is each row's own "…", through the Collection's row actions.
        const menus = screen.root.findAll(node => Array.isArray(node.props.secondaryActions)
            && node.props.secondaryActions[0]?.id === 'remove' && typeof node.props.onSecondaryAction === 'function');
        const pyMenu = menus.find(node => JSON.stringify(node.props.testID ?? '').includes('py')) ?? menus.at(-1);
        expect(pyMenu).toBeDefined();
        React.act(() => { pyMenu!.props.onSecondaryAction('remove'); });
        expect(handlers.onRemove.mock.calls.map(([entry]) => entry.id)).toEqual(['py']);
    });

    it('runs every kind of work directly when nothing is set, with no lifecycle to pick and the Agent’s own sandbox off', async () => {
        const { target, lifecycle, nativeSwitch, native } = await render();
        for (const kind of ['sessions', 'botsChannels', 'automationsWorkflows']) {
            expect(target(kind)).toMatchObject({ selectedId: 'directly', disabled: false });
            expect(lifecycle(kind)).toBeUndefined();
        }
        expect(nativeSwitch).toMatchObject({ value: false, disabled: false });
        expect(native?.subtitle).toBe('machineDetailPage.isolation.native.noSandbox');
    });

    it('shows each kind’s sandbox and lifecycle as separate choices and reports what the person picks', async () => {
        const { target, lifecycle, handlers } = await render({ policy: CONFIGURED, entries: ENTRIES });
        expect(target('sessions')?.selectedId).toBe('node');
        expect(target('sessions')?.items.map((item: { id: string }) => item.id)).toEqual(['directly', 'node', 'py']);
        expect(lifecycle('sessions')?.activeTabId).toBe('fresh');
        expect(lifecycle('botsChannels')?.activeTabId).toBe('shared-kept');
        target('automationsWorkflows')?.onSelect('py');
        lifecycle('sessions')?.onSelectTab('shared-kept');
        target('sessions')?.onSelect('directly');
        expect(handlers.onChooseTarget.mock.calls).toEqual([['automationsWorkflows', 'py'], ['sessions', null]]);
        expect(handlers.onChooseLifecycle).toHaveBeenCalledWith('sessions', 'shared-kept');
    });

    it('says up front which chosen sandbox type can’t host the Agent’s own sandbox, and blocks turning it on when none can', async () => {
        const mixed = await render({ policy: CONFIGURED, entries: ENTRIES });
        expect(String(mixed.native?.subtitle)).toContain('machineDetailPage.isolation.native.unavailableIn');
        expect(mixed.nativeSwitch.disabled).toBe(false);
        const none = await render({ policy: CONFIGURED, entries: ENTRIES.map(entry => ({ ...entry, supportsAgentNativeSandbox: false })) });
        expect(none.native?.subtitle).toBe('machineDetailPage.isolation.native.unavailable');
        expect(none.nativeSwitch).toMatchObject({ value: false, disabled: true });
    });

    it('keeps the policy visible offline, says why it can’t change, and disables every control', async () => {
        const { screen, target, lifecycle, nativeSwitch } = await render({ policy: CONFIGURED, entries: ENTRIES, readOnlyReason: 'offline-reason' });
        expect(findTestInstanceByTypeWithProps(screen, ItemGroup, { testID: 'machine-isolation-where' })?.props.description).toBe('offline-reason');
        expect(target('sessions')).toMatchObject({ selectedId: 'node', disabled: true });
        expect(lifecycle('sessions')?.disabled).toBe(true);
        expect(nativeSwitch.disabled).toBe(true);
        // Offline is said once, by the page head's freshness line: the section repeats nothing, controls stay disabled.
        const offline = await render({ policy: CONFIGURED, entries: ENTRIES, readOnlyReason: 'offline-reason', offline: true });
        expect(findTestInstanceByTypeWithProps(offline.screen, ItemGroup, { testID: 'machine-isolation-where' })?.props.description).toBeUndefined();
        expect(offline.target('sessions')?.disabled).toBe(true);
    });

    it('shows a failed save and a failed type check with their reason and Retry', async () => {
        const retrySave = vi.fn();
        const retryCheck = vi.fn();
        const { screen } = await render({ policy: CONFIGURED, entries: ENTRIES,
            saveFailure: { title: 'save', code: 'unavailable', onRetry: retrySave },
            checkFailure: { title: 'check', code: 'machine_offline', onRetry: retryCheck } });
        const save = findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-isolation-save-failure' })?.props;
        const check = findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-isolation-check-failure' })?.props;
        expect(save).toMatchObject({ kind: 'error', diagnosticCode: 'unavailable' });
        expect(check).toMatchObject({ kind: 'error', diagnosticCode: 'machine_offline' });
        save?.action.onPress();
        check?.action.onPress();
        expect(retrySave).toHaveBeenCalledOnce();
        expect(retryCheck).toHaveBeenCalledOnce();
    });

    // PRESETS-ACCEPT-1119 round 2: at 1440 the Sandboxes table drew a second rounded sheet inside its section's sheet when
    // the check-failed notice stood above it. The owner's rounded-sheet ruling (11-19) keeps that section's one edge.
    it.each([
        { state: 'with the check-failed notice above it', checkFailure: { title: 'check', code: 'machine_offline', onRetry: () => undefined } },
        { state: 'healthy', checkFailure: null },
    ])('keeps the Sandboxes table on its section sheet, one edge around it ($state)', async ({ checkFailure }) => {
        const { MachineIsolationPageView } = await import('./MachineIsolationPageView');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        const screen = await renderScreen(React.createElement(ListPresentationProvider, { value: 'page' },
            React.createElement(MachineIsolationPageView, {
                machineName: 'devbox', status: 'ready', policy: CONFIGURED, entries: ENTRIES, readOnlyReason: null, busy: false,
                saveFailure: null, checkFailure, onChooseTarget: vi.fn(), onChooseLifecycle: vi.fn(), onToggleNative: vi.fn(), onRemove: vi.fn(),
            } as never)));
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten)) : style !== null && typeof style === 'object' ? style as Record<string, unknown> : {};
        // A rounded, edged box at the page sheet's radius: a section's sheet or a table's own.
        const edged = (node: { type: unknown; props: { style?: unknown } }) => {
            if (typeof node.type !== 'string') return false;
            const style = flatten(node.props.style);
            return style.borderRadius === HAPPIER_PAGE_METRICS.sheetRadiusPx && Number(style.borderWidth ?? 0) > 0;
        };
        const section = findTestInstanceByTypeWithProps(screen, ItemGroup, { testID: 'machine-isolation-sandboxes' })!;
        // The table measures a desktop width (the renderer lays nothing out itself), where a bare table takes its sheet.
        const stage = section.findAll((node) => node.props.testID === 'machine-isolation-sandboxes-table:stage'
            && typeof node.props.onLayout === 'function')[0]!;
        await act(async () => {
            stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } });
        });
        const table = section.findAll((node) => node.props.testID === 'machine-isolation-sandboxes-table')[0]!;
        expect(table).toBeDefined();
        // Exactly one edge around the table: the section's sheet, never a second one of the table's own.
        expect(section.findAll(edged).filter((box) => box.findAll((node) => node === table).length > 0)).toHaveLength(1);
        // The table reads that it stands on the section's sheet: no list scope between them starts outside the sheet
        // again (a fresh scope clears the enclosing-sheet fact, and the Collection then drew a second sheet of its own).
        const { ListPresentationProvider: ScopeStart } = await import('@/components/ui/lists/listPresentation');
        const restarts = section.findAllByType(ScopeStart).filter((scope) => scope.findAll((node) => node === table).length > 0);
        expect(restarts).toHaveLength(0);
    });

    it('never shows an unreadable saved policy as Directly', async () => {
        const { screen, target } = await render({ status: 'invalid', policy: null });
        expect(findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-isolation-unreadable' })?.props.title)
            .toBe('machineDetailPage.isolation.invalid');
        expect(target('sessions')).toBeUndefined();
    });

    it('offers one way to add a sandbox, which stays put while nothing can change', async () => {
        const onAdd = vi.fn();
        // Nothing added yet: the invitation's one action; with sandboxes added, the add row under them.
        const empty = await render({ onAdd });
        const inviteAction = (screen: typeof empty.screen) => findTestInstanceByTypeWithProps(screen, EmptyState,
            { testID: 'machine-isolation-sandboxes-empty' })?.props.primaryAction;
        expect(inviteAction(empty.screen)?.disabled).toBeFalsy();
        await inviteAction(empty.screen)?.onPress();
        expect(onAdd).toHaveBeenCalledOnce();
        const editable = await render({ onAdd, policy: CONFIGURED, entries: ENTRIES });
        const add = findTestInstanceByTypeWithProps(editable.screen, Item, { testID: 'machine-isolation-add' })?.props;
        expect(add?.disabled).toBeFalsy();
        add?.onPress();
        expect(onAdd).toHaveBeenCalledTimes(2);
        const offline = await render({ onAdd, readOnlyReason: 'offline-reason' });
        expect(inviteAction(offline.screen)?.disabled).toBe(true);
    });
});
