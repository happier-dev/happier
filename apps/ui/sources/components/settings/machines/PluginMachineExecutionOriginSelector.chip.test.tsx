import * as React from 'react';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { composePluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginCandidateV1, PluginMachineSourceExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginSelectionV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

installDisconnectedServerSocketBoundary();
const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
const { storage } = await import('@/sync/domains/state/storageStore');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await account?.dispose();
    account = null;
});

async function installLiveMachine() {
    account = await restoreServerAccountForTest({ serverUrl: 'https://picker-presence.test', serverIdentityId: 'srv_picker_one' });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: Date.now(), updatedAt: Date.now() })], true,
        { sourceServerId: account.home.id });
}

const unlistedSource: PluginMachineSourceExecutionOriginCandidateV1 = {
    source: { origin: { serverIdentityId: 'srv_picker_one', sourceRef: { machineId: 'unknown-machine', pluginId: 'acme.plugin',
        sourceCustody: { kind: 'development', registeredRootId: 'source-a' } } }, version: '1.0.0', occurrenceId: 'occurrence-a', serverId: 'srv_picker_one' },
    releaseContent: 'matched', validation: { kind: 'admitted' },
};

function createSelection(machineIds: readonly [string, string] = ['machine-a', 'machine-b']) {
    const candidates: readonly PluginMachineExecutionOriginCandidateV1[] = [
        {
            materialization: {
                serverIdentityId: 'srv_picker_one', machineId: machineIds[0], materializationId: 'installation-a',
                pluginId: 'acme.plugin', version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 100,
            },
            releaseContent: 'matched', validation: { kind: 'admitted' },
        },
        {
            materialization: {
                serverIdentityId: 'srv_picker_one', machineId: machineIds[1], materializationId: 'installation-b',
                pluginId: 'acme.plugin', version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 100,
            },
            releaseContent: 'matched', validation: { kind: 'rejected', reason: 'offline' },
        },
    ];
    const selectOrigin = vi.fn(async () => ({ status: 'applied' as const, settingsVersion: 8, value: undefined }));
    const selection: PluginMachineExecutionOriginSelectionV1 = {
        candidates,
        state: { kind: 'selectionRequired', candidates },
        selectedOrigin: null,
        canExecute: false,
        loading: false,
        selectOrigin,
        clearOrigin: async () => ({ status: 'applied', settingsVersion: 8, value: undefined }),
        resolveExecutionOrigin: () => null,
    };
    return { selection, candidates, selectOrigin };
}

describe('PluginMachineExecutionOriginSelector header chip', () => {
    it('can clear a remembered Machine even when its current source candidates are absent', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const storedTarget = { serverIdentityId: 'srv_picker_one', machineId: 'machine-a' };
        const clearOrigin = vi.fn(async () => ({ status: 'applied' as const, value: undefined }));
        const selection: PluginMachineExecutionOriginSelectionV1 = { ...fixture.selection, candidates: [], storedTarget,
            state: { kind: 'unavailable', storedTarget, storedOrigin: null, candidates: [], reasons: ['offline'] }, clearOrigin };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={selection} presentation="chip" testIDPrefix="absent.execution" />, {
            // Test Renderer supplies neither browser anchor geometry nor portal layout.
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 100, top: 100, width: 320, height: 40 }) }),
        });
        await screen.pressByTestIdAsync('absent.execution.chip');
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        await screen.pressByTestIdAsync('absent.execution.clear');
        expect(clearOrigin).toHaveBeenCalledOnce();
        await screen.unmount();
    }));
    it('names a remembered unavailable Machine as offline on the chip and keeps it marked in the list', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const storedTarget = { serverIdentityId: 'srv_picker_one', machineId: 'machine-b' };
        const selection: PluginMachineExecutionOriginSelectionV1 = { ...fixture.selection, storedTarget,
            state: { kind: 'unavailable', storedTarget, storedOrigin: null, candidates: fixture.candidates, reasons: ['offline'] } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={selection} presentation="chip" testIDPrefix="pinned.execution" />);
        const chip = screen.findHostByTestId('pinned.execution.chip');
        expect(chip?.props.accessibilityHint).toBe('settingsProviders.detail.machineOffline');
        await screen.pressByTestIdAsync('pinned.execution.chip');
        const pinned = screen.findHostByTestId('pinned.execution.picker-option:machine-b');
        expect(pinned?.props.accessibilityState?.selected ?? pinned?.props['aria-selected']).toBe(true);
        await screen.unmount();
    }));
    it('shows real Online presence despite an old unchanged plugin observation', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [fixture.candidates[0]!] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(screen.getTextContent()).toContain('common.version 1.0.0');
    }));

    it.each(['offline', 'stale', 'home_unreachable'] as const)('states a Machine\'s connectivity once: a %s plugin observation never repeats it beside the presence line', (reason) => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const rejected = { ...fixture.candidates[0]!, validation: { kind: 'rejected' as const, reason } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [rejected] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const text = screen.getTextContent();
        expect(text).toContain('settingsOverview.machineOnline');
        expect(text).not.toContain('settingsPlugins.machineMatrix.state.staleOffline');
        expect(text).not.toContain('settingsProviders.detail.machineOffline');
        expect(text).not.toContain('pluginSurfaces.originReason.home_unreachable');
        expect(text).toContain('common.version 1.0.0');
    }));

    it('keeps plugin rejection separate from live Machine presence', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const rejected = { ...fixture.candidates[0]!, validation: { kind: 'rejected' as const, reason: 'disabled' as const } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [rejected] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const row = screen.findHostByTestId('plugin.execution.picker-option:machine-a');
        const text = screen.getTextContent();
        expect(text).toContain('settingsOverview.machineOnline');
        expect(text).toContain('settingsPlugins.machineMatrix.state.disabled');
        expect(text).not.toContain('settingsOverview.machineOffline');
        expect(row?.props.disabled ?? row?.props.accessibilityState?.disabled ?? row?.props['aria-disabled']).toBe(true);
    }));

    it('does not invent last-seen or a presence dot for a source without a Machine record', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [unlistedSource] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const text = screen.getTextContent();
        expect(text).not.toContain('settingsOverview.machineOffline');
        expect(text).not.toContain('settingsOverview.machineOnline');
        expect(screen.findHostByTestId('plugin.execution.picker-option:unknown-machine')).not.toBeNull();
        expect(screen.findHostByTestId('plugin.execution.picker-readiness:unknown-machine')).toBeNull();
    }));

    it('retains a stale plugin reason when no Machine presence line can explain it', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const rejected = { ...unlistedSource, validation: { kind: 'rejected' as const, reason: 'stale' as const } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [rejected] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.findHostByTestId('plugin.execution.picker-option:unknown-machine')).not.toBeNull();
        expect(screen.getTextContent()).toContain('settingsPlugins.machineMatrix.state.staleOffline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
    }));

    it('does not borrow a same-id Machine from another Home', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const otherHome = { ...fixture.candidates[0]!, materialization: {
            ...fixture.candidates[0]!.materialization, serverIdentityId: 'srv_picker_other',
        } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [otherHome] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.findHostByTestId('plugin.execution.picker-option:machine-a')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(screen.findHostByTestId('plugin.execution.picker-readiness:machine-a')).toBeNull();
    }));

    it('keeps a retained Machine online until its authoritative offline push', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        storage.getState().applyMachines([{ ...storage.getState().machines['machine-a']!, presenceProtocolVersion: 1 }], false,
            { sourceServerId: account!.home.id });
        vi.useFakeTimers();
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [fixture.candidates[0]!] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await act(async () => {
            storage.getState().applyMachines([{ ...storage.getState().machines['machine-a']!, activeAt: Date.now() }], false,
                { sourceServerId: account!.home.id });
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(201); });
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: 'machine-a', active: false, activeAt: Date.now() }], { sourceServerId: account!.home.id }));
        expect(screen.getTextContent()).toContain('settingsOverview.machineOffline');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        await act(async () => {
            storage.getState().applyMachines([{ ...storage.getState().machines['machine-a']!, active: true, activeAt: Date.now() }], false,
                { sourceServerId: account!.home.id });
        });
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(fixture.candidates[0]!.materialization.observedAt).toBe(100);
        await screen.unmount();
    }));

    it('opens the shared machine list and submits the exact installation while rejecting offline choices', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView
            selection={fixture.selection}
            presentation="chip"
            testIDPrefix="plugin.execution"
        />, {
            // Supply the browser anchor measurement that Test Renderer cannot produce.
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 100, top: 100, width: 320, height: 40 }) }),
        });
        expect(screen.findHostByTestId('plugin.execution.chip')).not.toBeNull();
        expect(screen.findHostByTestId('plugin.execution.picker-list')).toBeNull();
        await screen.pressByTestIdAsync('plugin.execution.chip');
        // Test Renderer supplies no native layout event for the measured portal.
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        expect(screen.findHostByTestId('plugin.execution.picker-list')).not.toBeNull();
        const offline = screen.findHostByTestId('plugin.execution.picker-option:machine-b');
        expect(offline?.props.disabled ?? offline?.props.accessibilityState?.disabled ?? offline?.props['aria-disabled']).toBe(true);
        await screen.pressByTestIdAsync('plugin.execution.picker-option:machine-a');
        expect(fixture.selectOrigin).toHaveBeenCalledWith(composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization));
        const chip = screen.findHostByTestId('plugin.execution.chip');
        expect(chip?.props.accessibilityState?.expanded ?? chip?.props['aria-expanded']).toBe(false);
    }));

    it('names a Machine Happier picked with a quiet Auto and offers no Clear; a pin has neither', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const origin = composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization);
        const picked = (selectionSource: 'auto' | 'pinned'): PluginMachineExecutionOriginSelectionV1 => ({ ...fixture.selection, selectedOrigin: origin,
            state: { kind: 'selected', origin, candidate: fixture.candidates[0]!, selectionSource }, canExecute: true });
        const auto = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={picked('auto')} presentation="chip" testIDPrefix="auto.execution" />);
        const autoChip = auto.findHostByTestId('auto.execution.chip');
        expect(autoChip?.props.accessibilityLabel).toContain('settingsPlugins.surfaces.runOnAuto');
        expect(autoChip?.props.accessibilityHint).toBe('settingsPlugins.surfaces.runOnAutoHint');
        await auto.pressByTestIdAsync('auto.execution.chip');
        expect(auto.findHostByTestId('auto.execution.clear')).toBeNull();
        await auto.unmount();
        const pinned = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={picked('pinned')} presentation="chip" testIDPrefix="pin.execution" />);
        const pinChip = pinned.findHostByTestId('pin.execution.chip');
        expect(pinChip?.props.accessibilityLabel).not.toContain('settingsPlugins.surfaces.runOnAuto');
        expect(pinChip?.props.accessibilityHint).toBeUndefined();
        await pinned.pressByTestIdAsync('pin.execution.chip');
        expect(pinned.findHostByTestId('pin.execution.clear')).not.toBeNull();
        await pinned.unmount();
    }));

    it('lets a phone header chip shrink to its glyph while still naming the Machine and announcing that Happier picked it', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const origin = composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization);
        const selection: PluginMachineExecutionOriginSelectionV1 = { ...fixture.selection, selectedOrigin: origin,
            state: { kind: 'selected', origin, candidate: fixture.candidates[0]!, selectionSource: 'auto' }, canExecute: true };
        const wide = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={selection} presentation="chip" testIDPrefix="wide.execution" />);
        expect(wide.getTextContent()).toContain('settingsPlugins.surfaces.runOnAuto');
        const wideName = wide.findHostByTestId('wide.execution.chip')?.props.accessibilityLabel;
        expect(wide.getTextContent()).not.toBe('');
        await wide.unmount();
        const compact = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={selection} presentation="chip" compact testIDPrefix="compact.execution" />);
        // Beside the page title and the page's action there is no room for a name: the glyph stands for it.
        expect(compact.getTextContent()).toBe('');
        const compactName = compact.findHostByTestId('compact.execution.chip')?.props.accessibilityLabel;
        expect(compactName).toBeTruthy();
        expect(wideName).toContain(compactName);
        expect(compact.findHostByTestId('compact.execution.chip')?.props.accessibilityHint).toBe('settingsPlugins.surfaces.runOnAutoHint');
        await compact.unmount();
    }));

    it('keeps the telling suffix of a same-named Machine whole while its name shortens, and announces the full identity', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const origin = composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization);
        const selection: PluginMachineExecutionOriginSelectionV1 = { ...fixture.selection, selectedOrigin: origin,
            state: { kind: 'selected', origin, candidate: fixture.candidates[0]!, selectionSource: 'pinned' }, canExecute: true };
        const machineCandidates = [{
            target: { serverIdentityId: 'srv_picker_one', machineId: 'machine-a' },
            displayName: 'Build box · 3ca2', displayNameParts: { name: 'Build box', hint: '3ca2' }, serverLabel: 'Home', availability: 'online' as const, observation: 'live' as const, observedAt: 100,
        }];
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={selection} machineCandidates={machineCandidates}
            presentation="chip" testIDPrefix="suffix.execution" />);
        const texts = screen.findAllByType('Text');
        const name = texts.find((node) => node.props.children === 'Build box');
        const suffix = texts.find((node) => node.props.children === '· 3ca2');
        expect(name).toBeTruthy();
        expect(suffix).toBeTruthy();
        expect(flattenTestStyle(name!.props.style).flexShrink).toBe(1);
        expect(flattenTestStyle(suffix!.props.style).flexShrink).toBe(0);
        expect(screen.findHostByTestId('suffix.execution.chip')?.props.accessibilityLabel).toContain('Build box · 3ca2');
        await screen.unmount();
    }));

    it('keeps Clear selection inside the machine list so a long list cannot clip it out of the popover', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const selection = { ...fixture.selection, selectedOrigin: composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization) };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={selection}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        let node = screen.findHostByTestId('plugin.execution.clear')?.parent ?? null;
        const ancestors: string[] = [];
        while (node) { if (typeof node.props?.testID === 'string') ancestors.push(node.props.testID); node = node.parent; }
        expect(ancestors.some((id) => id.startsWith('plugin.execution.picker-list') && id.endsWith('bodyFooter'))).toBe(true);
    }));

    it('tells same-named machines apart by a short suffix, never by the opaque machine id', () => withPopoverWebGlobals(async () => {
        const ids = ['3f9a2c10-7b1e-4d55-9a02-c1d5e8f01234', '8be4d1a7-52c3-4c0e-b6f9-0a41d7c9e555'] as const;
        const fixture = createSelection(ids);
        const machineCandidates = ids.map((machineId) => ({
            target: { serverIdentityId: 'srv_picker_one', machineId },
            displayName: 'Build box', serverLabel: 'Home', availability: 'online' as const, observation: 'live' as const, observedAt: 100,
        }));
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView
            selection={fixture.selection}
            machineCandidates={machineCandidates}
            presentation="chip"
            testIDPrefix="plugin.execution"
        />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const text = screen.getTextContent();
        expect(text).toContain('Build box · 3f9a');
        expect(text).toContain('Build box · 8be4');
        for (const id of ids) expect(text).not.toContain(id);
    }));
});
