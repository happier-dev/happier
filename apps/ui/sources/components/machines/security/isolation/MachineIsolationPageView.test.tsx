import * as React from 'react';
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
