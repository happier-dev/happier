import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { BotTemplateDraftV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { router } from 'expo-router';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { Modal, ModalProvider } from '@/modal';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { SessionTemplateSection } from './SessionTemplateSection';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { storage } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { CurrentUiContextHostCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { t } from '@/text';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { useOpenBotTemplate } from './openBotTemplate';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }));
const route = vi.hoisted(() => ({ pathname: '/session/source', listeners: new Set<() => void>() }));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('expo-router', async () => {
    const React = await import('react');
    const boundary = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: vi.fn((href: unknown) => {
        if (typeof href === 'string') route.pathname = href.split('?')[0];
        else if (href && typeof href === 'object' && 'pathname' in href && typeof href.pathname === 'string') route.pathname = href.pathname;
        for (const listener of route.listeners) listener();
    }) } });
    // Expo publishes committed navigation to pathname subscribers; rejected pushes publish nothing.
    return { ...boundary.module, usePathname: () => React.useSyncExternalStore(listener => {
        route.listeners.add(listener); return () => { route.listeners.delete(listener); };
    }, () => route.pathname) };
});
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@shopify/react-native-skia', async () => {
    const { createSkiaModuleMock } = await import('@/dev/testkit/mocks/skia');
    const { createReactNativeSkiaMock } = await import('@/dev/testkit/mocks/reactNativeSkia');
    const native = createSkiaModuleMock();
    native.boundary.rasterAvailable = false; // Node has no native image handles; face geometry stays real.
    const renderer = createReactNativeSkiaMock();
    // Rendering records opaque native pictures; navigation does not exercise a native canvas.
    return { ...renderer, ...native.module, createPicture: renderer.createPicture };
});

await loadSyncSingletonForTests();
afterEach(() => { standardCleanup(); Modal.hideAll(); vi.clearAllMocks(); route.pathname = '/session/source'; });

function SessionPane(props: React.ComponentProps<typeof SessionTemplateSection>) {
    const scopeId = useRegisterSessionPaneDriver(props.session.id, props.serverId);
    const { openRight, scopeState } = useAppPaneScope(scopeId);
    React.useEffect(() => { openRight({ tabId: 'info', present: false }); }, [openRight]);
    return <><RetainedPanelSurface isActive={scopeState?.right.isOpen === true} hiddenMode="activity" mode="flow">
        <SessionTemplateSection {...props} />
    </RetainedPanelSurface>
        <SessionDetailsPanel sessionId={props.session.id} routeServerId={props.serverId} scopeId={scopeId} />
    </>;
}

function PublishCommandProbe(props: Readonly<{ capture: (command: CurrentUiContextHostCommand | undefined) => void }>) {
    const commands = useCurrentUiContextComposedCommands();
    const command = commands.find(row => row.title === t('botTemplates.publishEllipsis'))?.command;
    props.capture(command?.kind === 'hostLocal' ? command : undefined);
    return null;
}

function StartScopeProbe(props: Readonly<{ capture: (scopeId: string | null) => void }>) {
    props.capture(useAppPaneContext(value => value.detailsStartScopeId));
    return null;
}

function TemplateCommandProbe(props: React.ComponentProps<typeof SessionTemplateSection> & Readonly<{
    capture: (invoke: ReturnType<typeof useOpenBotTemplate>) => void;
}>) {
    props.capture(useOpenBotTemplate(props.session, props.serverId));
    return null;
}

describe('Template opening from Info', () => {
    it.each([
        { phone: false, pane: false }, { phone: true, pane: false }, { phone: false, pane: true },
    ])('opens the private editor and reveals Publish after navigation (phone=$phone, pane=$pane)', async ({ phone, pane }) => {
        viewport.width = phone ? 390 : 1440;
        const serverUrl = `https://template-info-${phone ? 'phone' : pane ? 'pane' : 'desktop'}.test`;
        let sourceResponse: ReturnType<typeof createPlainSessionByIdResponseFixture> | undefined;
        const sourceReads = createSessionReadBatchFetchBoundary(async input =>
            new URL(String(input)).pathname === '/v2/sessions/source' && sourceResponse ? Response.json(sourceResponse) : null);
        const home = await createPlainArtifactHomeFixture(serverUrl, { currentAccount: true,
            handleRequest: async (path, init) => path === '/v2/account/settings'
                ? Response.json({ version: 1, content: { t: 'plain', v: {} } })
                : sourceReads(new URL(path, serverUrl).href, init) });
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        try {
            await home.hydrateAccountSettings();
            const serverId = home.home.id;
            const artifactId = '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d';
            const session = createSessionFixture({ id: 'source', serverId, metadata: {
                path: '/garden', host: 'author', bot: { kind: 'bot' }, work: { templateDraftRef: { serverId, artifactId } },
            } });
            sourceResponse = createPlainSessionByIdResponseFixture(session);
            // Info has already loaded this Session; Details reads the same canonical store.
            storage.getState().applySessions([session]);
            const draft = BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId, sessionId: session.id },
                releaseArtifactId: '5bdb3f40-e1b4-4e6b-b079-3ae53c6f1db4',
                content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Care for the herbs' },
                    memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
                candidates: { memoryRules: [], skills: [] } });
            const header = projectBotTemplateArtifactHeaderV1(draft);
            home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: artifactId, isDecrypted: true,
                title: header.title, header, body: JSON.stringify(draft), headerVersion: 1,
                bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'));
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
            account = await captureLazyActionAccountContext(serverId);
            let publishCommand: CurrentUiContextHostCommand | undefined;
            let startScopeId: string | null = null;
            let retiredCommand: ReturnType<typeof useOpenBotTemplate> = null;
            // Direct Info has the shell's pane provider, but no Session Details renderer/driver.
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <CurrentUiContextCommandsProvider authority={account.accountLifetime}>
                <PublishCommandProbe capture={command => { publishCommand = command; }} />
                <ModalProvider><AppPaneProvider>
                <StartScopeProbe capture={scopeId => { startScopeId = scopeId; }} />
                <DestinationInstanceHost tabId="direct-info" ref={{ kind: 'session', params: { id: session.id, serverId } }}
                    pathname={`/session/${session.id}${pane ? '' : '/info'}`} focused visible phone={phone}
                    navigation={{ ...router, pushRetainingCurrent: router.push }}>
                    <TemplateCommandProbe session={session} serverId={serverId} capture={invoke => { retiredCommand = invoke; }} />
                    {pane ? <SessionPane session={session} serverId={serverId} /> : <SessionTemplateSection session={session} serverId={serverId} />}
                </DestinationInstanceHost>
            </AppPaneProvider></ModalProvider></CurrentUiContextCommandsProvider></InjectedAuthProvider>);
            expect(screen.findByTestId('bot-template-editor')).toBeNull();
            await screen.pressByTestIdAsync('bot-template-author-row');
            await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(screen.findByTestId('bot-template-editor')).not.toBeNull();
            });
            expect(screen.getTextContent()).toContain('Garden');
            expect(Modal.alert).not.toHaveBeenCalled();
            if (pane) expect(Modal.show).not.toHaveBeenCalled();
            else expect(startScopeId).not.toBeNull();
            if (!phone && !pane) {
                // Invoke the editor's actual published command so navigation rejection can be awaited.
                await waitForHomeGovernance(() => expect(publishCommand).toBeDefined());
                const unavailable = new Error('Navigation unavailable');
                vi.mocked(router.push).mockImplementationOnce(() => { throw unavailable; });
                await act(async () => {
                    await expect(publishCommand!.invoke({ signal: new AbortController().signal, context: {} }))
                        .rejects.toBe(unavailable);
                });
                expect(screen.findByTestId('bot-template-editor')).not.toBeNull();
                vi.mocked(router.push).mockClear();
            }
            await screen.pressByTestIdAsync('bot-template-publish');
            await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(router.push).toHaveBeenCalledWith({ pathname: '/settings/plugins/publish',
                    params: { templateArtifactId: artifactId, templateServerId: serverId } });
                // A retained Session pane stays mounted; a borrowed sheet must expose the new page.
                expect(screen.findByTestId('bot-template-editor') !== null).toBe(pane);
            });
            expect(home.boundary.readPlainBody(draft.releaseArtifactId)).toBeNull();
            await screen.unmount();
            // A retired Info command receives the same typed cancellation as an in-flight
            // open whose successful pane handoff hid Info. It must not report a missing template.
            expect(retiredCommand).not.toBeNull();
            await retiredCommand!();
            expect(Modal.alert).not.toHaveBeenCalled();
        } finally { account?.dispose(); await home.dispose(); }
    });
});
