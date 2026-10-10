import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DestinationInstanceHost, useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { BrowserPresentationRetentionProvider } from '@/components/browser/surfaces/browserPresentationRetention';
import { createBrowserViewDetailsTab } from '@/components/browser/surfaces/browserSurfaceDetailsTabModel';
import { BrowserShell } from '@/components/browser/BrowserShell';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { EMPTY_PLUGIN_BROWSER_PROJECTION } from '@/sync/domains/plugins/browser/targets';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { SessionRightPanelBrowserView } from './SessionRightPanelBrowserView';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { SessionBrowserContextRuntimeProvider, useSessionBrowserContextRuntime } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { selectBrowserContextComposerAttachments } from '@/sync/domains/browser/context/selectors';

// Only native rendering/font loading and the external Socket.IO connection are replaced.
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const initialStorage = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    storage.setState(initialStorage, true);
});

describe('Session right-panel Browser source lifetime', () => {
    it('keeps the actual Browser control and page navigation while its pane is parked and rebound', async () => {
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://browser-viewer-home.example.test',
            request: async (input) => {
                const pathname = new URL(String(input)).pathname;
                if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, context: { enabled: true } } } }));
                return new Response('{}', { status: 404 });
            },
        });
        const serverId = connection.home.id;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.scope.serverId).toBe(serverId);
        const machine = createMachineFixture({ id: 'viewer-machine' });
        const session = createSessionFixture({ id: 'viewer-session', serverId, metadata: { machineId: machine.id, path: '/repo', host: 'viewer.local' } });
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const projection = {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
            pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
            accountLifetime,
            phase: 'current', interactionEnabled: true, machineId: machine.id, serverId: null, platform: 'web',
        } satisfies PluginUiProjectionCurrentness;
        const tab = createBrowserViewDetailsTab({
            target: { kind: 'externalUrl', targetId: 'viewer-preview', url: 'https://preview.example.test/' },
            browserSessionId: 'retained-viewer-browser', viewId: 'retained-viewer-view',
        });
        function SeedBrowserTab(): null {
            const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(session.id, serverId));
            const pane = useAppPaneScope(scopeId);
            React.useEffect(() => { pane.openDetailsTab(tab, { intent: 'pinned' }); }, [pane.openDetailsTab]);
            return null;
        }
        function Harness(props: Readonly<{ presentation: 'pane' | 'parked' | 'phone' }>): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: session.id, scopeKey: session.id });
            return <AppPaneProvider><BrowserPresentationRetentionProvider><SessionViewerSourceAccountScopeProvider accountLifetime={accountLifetime}>
                <DestinationInstanceHost tabId="viewer-destination" ref={{ kind: 'session', params: { id: session.id } }} pathname={`/session/${session.id}`} focused visible>
                    <SessionBrowserContextRuntimeProvider runtime={runtime}>
                    {React.createElement('ComposerBrowserContextProbe', {
                        attachments: runtime ? selectBrowserContextComposerAttachments(runtime.composerContext.state) : [],
                    })}
                    <SeedBrowserTab />
                    {props.presentation !== 'parked' && <SessionRightPanelBrowserView key={props.presentation} sessionId={session.id} pluginProjection={projection} />}
                    </SessionBrowserContextRuntimeProvider>
                </DestinationInstanceHost>
            </SessionViewerSourceAccountScopeProvider></BrowserPresentationRetentionProvider></AppPaneProvider>;
        }
        const screen = await renderScreen(<Harness presentation="pane" />);
        const execute = createDefaultRuntimeActionExecutor();
        async function navigate(commandId: string, url: string): Promise<unknown> {
            let result: unknown;
            await act(async () => {
                result = await execute({ actionId: 'browser.navigate', input: {
                    kind: 'navigate', commandId, browserSessionId: 'retained-viewer-browser', viewId: 'retained-viewer-view', url,
                }, context: {} });
            });
            return result;
        }
        expect(await navigate('before-park', 'https://preview.example.test/first')).toMatchObject({ status: 'dispatched' });
        await screen.update(<Harness presentation="parked" />);
        expect(await navigate('while-parked', 'https://preview.example.test/retained')).toMatchObject({ status: 'dispatched' });
        await screen.update(<Harness presentation="phone" />);
        expect(screen.findAllByType(BrowserShell)).toHaveLength(1);
        expect(screen.findAllByType(DetailsSplitWorkspace)).toHaveLength(0);
        expect(screen.findByType('iframe').props.src).toBe('https://preview.example.test/retained');
        const attachPage = screen.find((node) => typeof node.props.testID === 'string'
            && node.props.testID.endsWith('-attach-page') && typeof node.props.onPress === 'function');
        await screen.pressByTestIdAsync(attachPage.props.testID);
        expect(screen.findByType('ComposerBrowserContextProbe').props.attachments).toMatchObject([
            { sourceViewId: 'retained-viewer-view', state: 'available' },
        ]);
    });
});
