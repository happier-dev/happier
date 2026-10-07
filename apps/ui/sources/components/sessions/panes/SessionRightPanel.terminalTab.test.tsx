import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

let phone = false;
// Safe-area measurements come from the native SDK, not the chrome owner.
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));
installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Platform: { isPad: false },
            useWindowDimensions: () => ({ width: phone ? 390 : 1024, height: phone ? 844 : 768, scale: 1, fontScale: 1 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({ features: { terminal: { embeddedPty: { enabled: true } } } }),
});
beforeEach(() => {
    phone = false;
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'terminal.embeddedPty': true } });
});
async function renderPanel() {
    const { SessionRightPanel } = await import('./SessionRightPanel');
    return renderScreen(<runtime.Wrapper><SessionRightPanel sessionId="s1" scopeId="session:s1" /></runtime.Wrapper>);
}
async function createRightSidebarProjection(pluginId: string, descriptorId: string): Promise<PluginUiProjectionModel> {
    const { PluginProjectionV2Schema } = await import('@happier-dev/protocol');
    const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId, destinationId: descriptorId, rendererId: descriptorId + '-native',
        container: 'rightSidebarTab', target: { kind: 'session' },
    });
    if (!binding) throw new Error('Expected admitted Session sidebar binding');
    return normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: 4, installedPackagesById: {}, agentsById: {}, actionsById: {},
        toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {},
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            [descriptorId]: {
                id: descriptorId, pluginId, occurrenceId: pluginId + '#1',
                contributionKind: 'surfacePlacement', descriptorId, binding, target: binding.target,
                renderer: { kind: 'declarative', contributionId: descriptorId + '-native' },
                display: { developerFallback: descriptorId },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                headerActions: [],
            },
        } } }, diagnostics: [],
    }));
}
describe('SessionRightPanel (terminal tab)', () => {
    it('applies the native top inset once at the legacy header, not the pane root', async () => {
        const screen = await renderPanel();
        const root = screen.findHostByTestId('session-right-panel-root');
        const close = screen.findHostByTestId('session-rightpanel-close');
        if (!root || !close) throw new Error('Expected panel chrome');
        const flatten = (style: unknown): Record<string, unknown> => {
            if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
            return style !== null && typeof style === 'object' ? Object.fromEntries(Object.entries(style)) : {};
        };
        expect(flatten(root.props.style).paddingTop ?? 0).toBe(0);
        const headers = screen.root.findAll((node) => typeof node.type === 'string'
            && flatten(node.props.style).paddingTop === 34
            && node.findAll((descendant) => descendant === close).length === 1);
        expect(headers).toHaveLength(1);
    });

    it('offers Terminal in the phone sidebar only when policy enables it', async () => {
        phone = true;
        const screen = await renderPanel();
        expect(screen.findHostByTestId('session-rightpanel-tab:terminal')).not.toBeNull();
        await act(async () => storage.getState().applySettingsLocal({ featureToggles: { 'terminal.embeddedPty': false } }));
        expect(screen.findHostByTestId('session-rightpanel-tab:terminal')).toBeNull();
    });

    it('puts Terminal in the bottom pane on larger devices', async () => {
        const screen = await renderPanel();
        expect(screen.findHostByTestId('session-rightpanel-tab:terminal')).toBeNull();
    });

    it('renders session plugin tabs from the admitted scoped runtime instead of the app-shell machine', async () => {
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
        const scoped = await createRightSidebarProjection('acme.scoped', 'scoped-session-tab');
        const global = await createRightSidebarProjection('acme.global', 'global-session-tab');
        const screen = await renderScreen(<runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: global, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: 'machine-global', serverId: 'server-global', platform: 'ios',
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
        }}>
            <SessionRightPanel sessionId="s1" scopeId="session:s1" paneSurfaceScope={{
                targetKind: 'session', sessionId: 's1', serverId: runtime.serverId, machineId: 'machine-session',
                pluginUiProjection: scoped, pluginBrowserProjection: null, projectionPhase: 'current', interactionEnabled: true, platform: 'ios',
            }} />
        </AppShellPluginUiProjectionValueProvider></runtime.Wrapper>);
        expect(screen.findHostByTestId('session-rightpanel-tab:plugin:acme.global:global-session-tab')).toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-tab:plugin:acme.scoped:scoped-session-tab')).not.toBeNull();
        await act(async () => runtime.pane.selectRightDestination({ kind: 'plugin', destination: { pluginId: 'acme.scoped', localId: 'scoped-session-tab' } }));
        const host = screen.findByType(PluginSurfacePlacementHost);
        expect(host?.props).toMatchObject({ machineId: 'machine-session', serverId: runtime.serverId });
        expect(host?.props.placement.descriptorId).toBe('scoped-session-tab');
    });
});
