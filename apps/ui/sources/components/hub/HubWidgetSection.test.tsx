import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { WIDGET_SIZE_POLICY_V1 } from '@happier-dev/protocol/widgets';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createNearViewportTracker } from '@/components/widgets/nearViewport';
import {
    PluginAppPageLaunchInputScope, usePluginAppPageLaunch, usePluginAppPageLaunchInputStaging,
} from '@/components/appShell/plugins/pluginAppPageNavigation';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { HubWidgetSection } from './HubWidgetSection';

const boundary = vi.hoisted(() => ({ projection: null as PluginUiProjectionModel | null, pushed: [] as unknown[], stage: null as ((open: { pageId: string; subPath: string; input: { selection: string } }) => boolean) | null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', router: { push: (href: unknown) => boundary.pushed.push(href) } }).module);
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({}));
vi.mock('@/sync/store/hooks', async () => await import('@/sync/domains/state/storage'));
// Unused HTTP envelope API is outside this navigation corridor. Throw if reached;
// the test must never perform Session key preparation or network mutation.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Envelope HTTP API is not part of Home widget navigation'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
// App-shell admitted projection input is the external daemon feed. Destination
// normalization, catalog availability, activation and launch custody are real.
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ pluginUiProjection: boundary.projection }),
    useProjectedPluginLocalizedTextResolver: () => undefined,
}));

function projection(availability: 'available' | 'disabled' = 'available', phase: 'current' | 'retainedOffline' = 'current', pageCount = 1) {
    const entries = Array.from({ length: pageCount }, (_, index) => {
        const localId = index === 0 ? 'notes' : `page-${index}`;
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.notes', destinationId: localId, rendererId: 'notes-native', container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('admitted page binding required');
        return { id: `surfacePlacement:acme.notes:${localId}`, pluginId: 'acme.notes', occurrenceId: 'acme.notes#1', contributionKind: 'surfacePlacement', descriptorId: localId, binding, target: binding.target, renderer: { kind: 'declarative', contributionId: 'notes-native' }, display: { title: 'Notes' }, availability: { state: availability, reason: availability === 'available' ? 'available' : 'plugin_disabled', diagnostics: [] } };
    });
    const normalized = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(entries.map((entry) => [entry.id, entry])) } } }));
    return unionPluginUiProjections([{ machineId: 'machine-a', serverId: 'home-a', projection: normalized, phase, interactionEnabled: phase === 'current' }], new Map(), 'machine-a').pluginUiProjection;
}
const widget = { sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize }, key: 'acme.notes/status', surface: { pluginId: 'acme.notes', localId: 'status' }, title: 'Notes status', pluginName: 'Notes', sharedPluginName: false, icon: 'note' as const, homeDefault: 'shown' as const, target: 'app' as const };
const instance = { v: 1 as const, id: 'notes-copy', definition: { kind: 'installed' as const, surface: widget.surface }, bindings: {} };
function LaunchProbe() {
    boundary.stage = usePluginAppPageLaunchInputStaging();
    const open = usePluginAppPageLaunch({ pluginId: 'acme.notes', localId: 'notes', subPath: '' });
    return <>{open ? JSON.stringify(open.input) ?? 'input-cleared' : 'no-open'}</>;
}
function home() {
    return <PluginAppPageLaunchInputScope pluginUiProjection={boundary.projection}><LaunchProbe /><HubWidgetSection widget={widget} instance={instance} frameStyle="plain" menu={null} tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 800 })} testID="home-widget" /></PluginAppPageLaunchInputScope>;
}
beforeEach(() => { boundary.projection = projection(); boundary.pushed = []; clearActiveUnsavedChangesGuard(); });
afterEach(() => { clearActiveUnsavedChangesGuard(); standardCleanup(); });

describe('Home widget Open', () => {
    it('opens through the catalog launch owner, clearing a previously staged plugin argument', async () => {
        const screen = await renderScreen(home());
        await act(async () => { boundary.stage?.({ pageId: 'plugin:acme.notes:notes', subPath: '', input: { selection: 'previous' } }); });
        expect(screen.getTextContent()).toContain('previous');
        await act(async () => { screen.pressByTestId('home-widget.frame.open'); });
        await flushHookEffects({ cycles: 3 });
        expect(boundary.pushed).toEqual(['/plugins/acme.notes/notes']);
        expect(screen.getTextContent()).toContain('input-cleared');
        expect(screen.getTextContent()).not.toContain('previous');
    });
    it('respects a declined dirty-navigation decision without clearing the prior launch', async () => {
        const screen = await renderScreen(home());
        await act(async () => { boundary.stage?.({ pageId: 'plugin:acme.notes:notes', subPath: '', input: { selection: 'previous' } }); });
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'home-widget-test' });
        await act(async () => { screen.pressByTestId('home-widget.frame.open'); });
        await flushHookEffects({ cycles: 3 });
        expect(boundary.pushed).toEqual([]);
        expect(screen.getTextContent()).toContain('previous');
    });
    it.each(['disabled', 'ambiguous'] as const)('offers no Open for an %s page', async (state) => {
        boundary.projection = state === 'disabled' ? projection('disabled') : projection('available', 'current', 2);
        const screen = await renderScreen(home());
        expect(screen.findByTestId('home-widget.frame.open')).toBeNull();
        expect(boundary.pushed).toEqual([]);
    });
});
