import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

// Only native geometry/font rendering and the external socket connection are
// substituted. The pane reducer/provider, launch resolver/store and Account
// credential producer remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
installDisconnectedServerSocketBoundary();
// The real app entry loads syncEngine before any route can render a surface.
// Keep that producer ordering while retaining the actual host and singleton.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { storage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');

describe('AppPaneScopeHost exact Home launch lifetime', () => {
    it('keeps a Home B pane launcher across Home A retirement and refuses it when its real Home B credentials retire', async () => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const homeA = await upsertServerProfileOnly({ serverUrl: 'https://pane-account-a.test', name: 'Pane Home A' });
        const homeB = await upsertServerProfileOnly({ serverUrl: 'https://pane-account-b.test', name: 'Pane Home B' });
        const sessionId = 'home-b-launch-session';
        const scopeId = createSessionPaneScopeId(sessionId, homeB.id);
        const pluginId = 'acme.pane-lifetime';
        const destination = { pluginId, localId: 'notes' };
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: destination.localId,
            rendererId: 'notes-renderer', container: 'rightPane', target: { kind: 'session' } });
        if (!binding) throw new Error('The canonical destination schema refused the pane fixture');
        const placement = {
            id: 'surfacePlacement:acme.pane-lifetime:notes', pluginId, occurrenceId: 'notes-occurrence',
            contributionKind: 'surfacePlacement', descriptorId: 'notes', binding,
            target: binding.target, renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' },
            display: { developerFallback: 'Notes' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [], hostOrigin: { machineId: 'pane-machine-b', serverId: homeB.id,
                phase: 'current', interactionEnabled: true,
                executionOrigin: PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_pane_home_b',
                    materializationRef: { pluginId, machineId: 'pane-machine-b', materializationId: 'notes-install-b' } }) },
        } satisfies PluginUiSurfacePlacementProjection;
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            surfacePlacementsById: { [placement.id]: placement } };
        storage.getState().activateProfileScope({ serverId: homeA.id, accountId: 'pane-account-a' });
        publishAppliedActiveServerSnapshot({ serverId: homeA.id, serverUrl: homeA.serverUrl, generation: 1 });
        const homeALifetime = captureActiveServerAccountScopeLifetime();
        expect(homeALifetime?.isCurrent()).toBe(true);
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'pane-account-b' })).toString('base64url')}.signature` };
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentials)).toBe(true);
        const published: { open?: PluginSurfaceOpenHandler; lifetime?: ServerAccountScopeLifetime | null;
            right?: ReturnType<typeof useAppPaneContext>['state']['scopes'][string]['right'] } = {};
        const publishOpen = (open: PluginSurfaceOpenHandler | undefined) => { published.open = open; };
        function PaneState() {
            const context = useAppPaneContext();
            published.right = context.state.scopes[scopeId]?.right;
            return null;
        }
        function Harness() {
            const { binding: lifetime } = useServerCredentialAccountScopeBinding(homeB.id);
            published.lifetime = lifetime;
            return <AppPaneProvider><AppPaneScopeHost scopeId={scopeId} main={<PaneState />}
                surfaceScope={{ targetKind: 'session', sessionId, machineId: 'pane-machine-b', serverId: homeB.id,
                    accountLifetime: lifetime, pluginUiProjection: projection, platform: 'web',
                    projectionPhase: lifetime ? 'current' : 'unavailable', interactionEnabled: Boolean(lifetime) }}
                onPluginSurfaceOpenChange={publishOpen} /></AppPaneProvider>;
        }
        const screen = await renderScreen(<Harness />);
        try {
            await vi.waitFor(() => expect(published.lifetime?.scope.accountId).toBe('pane-account-b'));
            const escapedOpen = published.open;
            if (!escapedOpen) throw new Error('The actual pane owner did not publish its launcher');
            await act(async () => { expect(await escapedOpen({ destination })).toEqual({ ok: true }); });
            expect(published.right?.selectedDestination).toEqual({ kind: 'plugin', destination });
            const homeBLifetime = published.lifetime;
            await act(async () => {
                storage.getState().activateProfileScope({ serverId: homeA.id, accountId: 'pane-account-a-next' });
                expect(homeALifetime?.isCurrent()).toBe(false);
                expect(homeBLifetime?.isCurrent()).toBe(true);
                expect(await escapedOpen({ destination, input: { addressedTo: 'home-b' } })).toEqual({ ok: true });
            });
            const currentOpen = published.open;
            if (!currentOpen) throw new Error('The still-current Home B pane lost its launcher');
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toBe(true);
                expect(homeBLifetime?.isCurrent()).toBe(false);
                expect(await currentOpen({ destination, input: { addressedTo: 'retired-home-b' } })).toMatchObject({ ok: false, code: 'unavailable' });
            });
            await vi.waitFor(() => expect(published.lifetime).toBeNull());
            const unqualifiedOpen = published.open;
            if (unqualifiedOpen) {
                await act(async () => {
                    expect(await unqualifiedOpen({ destination })).toMatchObject({ ok: false, code: 'unavailable' });
                });
            }
        } finally {
            await screen.unmount();
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });
});
