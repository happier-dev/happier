import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const viewport = vi.hoisted(() => ({ width: 390 }));
// The viewport/native renderer is the external platform boundary. Pane state,
// driver registration, cockpit presentation and terminal leaves remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown in terminal presentation'); },
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { PanePresentationProvider } = await import('@/components/appShell/panes/panePresentation');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { SessionTerminalSurface } = await import('./surfaces/SessionTerminalSurface');
const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionPaneScopeId } = await import('./sessionPaneScopeId');
const { initializeSessionTerminalWorkspaceForScope } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');
const { readSessionTerminalWorkspace } = await import('@/components/sessions/terminal/sessionTerminalWorkspace');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';

const presentPane = () => {};
let pane: ReturnType<typeof useAppPaneContext>;
function ObservePane() { pane = useAppPaneContext(); return null; }
function Draft() {
    const [text, setText] = React.useState('warm draft');
    return React.createElement('RetainedChatDraft', { text, setText });
}
function Scene(props: Readonly<{ surface: 'chat' | 'terminal'; runtime: SessionPluginRuntimeState }>) {
    const scopeId = useRegisterSessionPaneDriver('session', props.runtime.serverId, props.runtime);
    return <AppPaneScopeHost scopeId={scopeId} main={props.surface === 'terminal'
        ? <SessionTerminalSurface sessionId="session" scopeId={scopeId} /> : <Draft />} />;
}
function Cockpit(props: Readonly<{ surface: 'chat' | 'terminal'; runtime: SessionPluginRuntimeState; admitted?: boolean }>) {
    return <AppPaneProvider><ObservePane /><PanePresentationProvider value={presentPane}>
        {props.admitted !== false && (['chat', 'terminal'] as const).map(surface => <PluginSurfaceFocusEligibilityProvider key={surface} active={props.surface === surface}>
            <Scene surface={surface} runtime={props.runtime} />
        </PluginSurfaceFocusEligibilityProvider>)}
    </PanePresentationProvider></AppPaneProvider>;
}

describe('Session pane driver with retained cockpit terminal scenes', () => {
    beforeEach(async () => { await standardCleanup(); await homes.reset(); viewport.width = 390;
        (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse({})), storage.getState().applyLocalSettings({ })); });
    afterEach(async () => { await standardCleanup(); await homes.reset(); });
    it('mounts one phone terminal view and retains the Chat draft and terminal workspace across scene returns', async () => {
        const serverId = await homes.addHome({ name: 'Terminal Home', serverUrl: 'https://terminal-scenes.test', accountId: 'alice', currentAccount: true });
        const features = createRootLayoutFeaturesResponse({ features: { terminal: { embeddedPty: { enabled: true } } } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        await getServerFeaturesSnapshot({ serverId, force: true });
        // Saving a Home does not restore its UI Account. Install that separate
        // fixture fact through the real scope/settings producers before mounting.
        const accountScope = { serverId, accountId: 'alice' };
        storage.getState().activateProfileScope(accountScope);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.getState().applySettingsForScope(accountScope, settingsParse({ featureToggles: { 'terminal.embeddedPty': true } }), 1);
        const runtime = { serverId, machineId: null, pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
            pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, platform: 'web', accountLifetime: null } satisfies SessionPluginRuntimeState;
        const scopeId = createSessionPaneScopeId('session', serverId);
        const screen = await renderScreen(<Cockpit surface="chat" runtime={runtime} admitted={false} />);
        await act(async () => {
            initializeSessionTerminalWorkspaceForScope(scopeId, readSessionTerminalWorkspace(undefined));
            pane.dispatch({ type: 'openRight', scopeId, tabId: 'terminal' });
        });
        await screen.update(<Cockpit surface="chat" runtime={runtime} />);
        await act(async () => { screen.root.findByType('RetainedChatDraft').props.setText('edited warm draft'); });
        const original = pane.state.scopes[scopeId].bottom.tabState.terminal;
        const leaves = () => screen.root.findAll(node => node.props.terminalIdentity?.terminalKey === `${scopeId}:terminal`);
        expect.soft(leaves()).toHaveLength(0);
        await screen.update(<Cockpit surface="terminal" runtime={runtime} />);
        expect.soft(leaves()).toHaveLength(1);
        expect(pane.state.scopes[scopeId].bottom.tabState.terminal).toBe(original);
        await screen.update(<Cockpit surface="chat" runtime={runtime} />);
        expect.soft(leaves()).toHaveLength(0);
        expect(screen.root.findByType('RetainedChatDraft').props.text).toBe('edited warm draft');
        await screen.update(<Cockpit surface="terminal" runtime={runtime} />);
        expect.soft(leaves()).toHaveLength(1);
        expect(pane.state.scopes[scopeId].bottom.tabState.terminal).toBe(original);
    });
});
