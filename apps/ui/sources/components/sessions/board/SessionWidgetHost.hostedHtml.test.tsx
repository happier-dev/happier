import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { Dimensions } from 'react-native';
import * as Unistyles from 'react-native-unistyles';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PluginHostedWebBridgeEnvelopeV1,
} from '@happier-dev/protocol/plugins/ui';

import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { createSessionCallerHostedHtmlRequestController } from '@/components/ui/surfaces/hostedHtml/sessionCallerHostedHtmlRequestController';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { darkTheme, lightTheme } from '@/theme';
import { SessionWidgetHost } from './SessionWidgetHost';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { SESSION_BOARD_SEMANTIC_HEIGHTS } from './sessionBoardItemHeight';
import type { SessionBoardItemProjection, SessionBoardMountHost } from '@/sync/domains/session/board';

const state = vi.hoisted(() => ({
    frames: [] as Record<string, unknown>[],
    openedExternalUrls: [] as string[],
    physicalMounts: 0,
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: async (url: string) => {
        state.openedExternalUrls.push(url);
        return true;
    },
}));

// BrowserViewFrame is the physical iframe boundary. The Session shell, caller
// adapter, shared HostedFrameHost, PluginHostedWebFrame, HostedPluginTarget and
// incumbent bridge above it remain real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: Record<string, unknown> }>) => {
        const [count, setCount] = React.useState(0);
        React.useEffect(() => { state.physicalMounts += 1; }, []);
        state.frames.push(props.engine);
        return React.createElement('BrowserViewFrame', { count, increment: () => setCount(value => value + 1) });
    },
}));

const item = {
    itemId: 'caller-widget-1',
    revision: 'revision-7',
    state: {
        kind: 'ready',
        item: {
            v: 1,
            title: 'Caller card',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: {
                kind: 'hostedHtml',
                source: artifactHtmlBundleFromBodyV1('<main>caller-owned</main>'),
                requestedCapabilities: {
                    hostMethods: ['context', 'executeAction', 'notify'],
                    actions: ['session.board.get'],
                    networkOrigins: ['https://api.example.com'],
                },
            },
            input: { view: 'summary' },
        },
    },
} satisfies SessionBoardItemProjection;

function runtime(sessionId = 'session-1', serverIdentityId = 'server-identity-a'): CallerHostedHtmlRuntime {
    return {
        serverIdentityId,
        accountId: 'account-a',
        accountEncryptionMode: 'plain',
        hostOrigin: 'https://app.example.com',
        // A trusted installed-plugin-only method is deliberately present in the
        // runtime ceiling. The caller manifest must still expose only its exact
        // reviewed request.
        admittedHostMethods: ['context', 'watchContext', 'executeAction', 'notify', 'readClipboard'],
        createRequestController: publishResourceEvent => createSessionCallerHostedHtmlRequestController({
            sessionId, serverId: 'home-a', serverIdentityId, accountId: 'account-a',
            executeHostAction: createFrontDoorActionExecute(),
            isAccountCurrent: () => storage.getState().profileScope?.accountId === 'account-a',
            isSessionCurrent: () => storage.getState().sessions[sessionId]?.access?.capabilities.readTranscript === true,
            pluginTarget: null, publishResourceEvent, notify: () => {},
        }),
        lifetime: {
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        },
    };
}

function readFrameBridge(frame: Record<string, unknown>) {
    const document = String(frame.html);
    const encodedConfig = document.match(/Object\.freeze\((\{.*?\})\),writable:false/)?.[1];
    if (!encodedConfig) throw new Error('expected_caller_html_frame_bootstrap');
    const config = JSON.parse(encodedConfig) as Readonly<{
        identity: Readonly<{ instanceId: string; mountNonce: string }>;
    }>;
    const webMessageBridge = frame.webMessageBridge as Readonly<{
        onMessage: (
            event: MessageEvent,
            receipt: Readonly<{ consumeTransientActivation: () => boolean }>,
        ) => Promise<unknown> | unknown;
    }>;
    const onMessage = async (message: PluginHostedWebBridgeEnvelopeV1): Promise<unknown> => await webMessageBridge.onMessage(
        { data: message, origin: 'null' } as MessageEvent,
        { consumeTransientActivation: () => false },
    );
    return { identity: config.identity, bootstrap: config, onMessage };
}

async function awaitHostedBodies(screen: Awaited<ReturnType<typeof renderScreen>>, count = 1) {
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.tree.root.findAllByType('BrowserViewFrame'), screen.getTextContent()).toHaveLength(count);
    });
}

async function renderPlacement(
    host: SessionBoardMountHost,
    renderedItem: SessionBoardItemProjection = item,
    bodyActive = true,
) {
    const screen = await renderScreen(<SessionWidgetHost
        sessionId="session-1"
        item={renderedItem}
        host={host}
        bodyActive={bodyActive}
        density={host === 'sidebar' ? 'compact' : 'full'}
        canEdit
        heightBounds={{ min: 96, max: 520 }}
        callerHostedHtmlRuntime={runtime()}
        resolveSourceAvailability={() => ({ kind: 'available' })}
        testID="caller-widget"
    />);
    if (bodyActive) await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.tree.root.findAllByType('BrowserViewFrame').length > 0
            || screen.findByTestId('caller-widget-hosted-html-unavailable') !== null).toBe(true);
    });
    return screen;
}

describe('SessionWidgetHost caller-authored hosted HTML', () => {
    afterEach(() => {
        standardCleanup();
        storage.setState({ sessions: {}, profileScope: null });
        vi.restoreAllMocks();
    });

    beforeEach(async () => {
        standardCleanup();
        // The real browser bundle includes its guest bootstrap before a person
        // opens a visual; load those authored bytes rather than timing Vite's
        // first generated-module transform inside a mounted-frame assertion.
        await act(async () => {
            await loadPluginUiHostSupport();
            await import('@/components/plugins/hostedWeb/guestBootstrap.generated');
        });
        state.frames = [];
        state.physicalMounts = 0;
        state.openedExternalUrls = [];
        storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } });
        storage.getState().applySessions([createSessionFixture({ id: 'session-1', serverId: 'home-a' })]);
    });

    it('gives an expanded caller frame its semantic room, then follows long intrinsic content without a card cap', async () => {
        const fixedItem: SessionBoardItemProjection = { ...item, state: { kind: 'ready', item: {
            ...item.state.item, height: { mode: 'fixed', size: 'regular' },
        } } };
        const screen = await renderScreen(<SessionWidgetHost sessionId="session-1" item={fixedItem}
            host="details" density="full" expanded canEdit
            heightBounds={{ min: 96, max: 520 }} callerHostedHtmlRuntime={runtime()}
            resolveSourceAvailability={() => ({ kind: 'available' })} testID="caller-widget" />);
        await awaitHostedBodies(screen);
        expect(screen.findByType(WidgetFrame).props.viewportHeight).toBe(SESSION_BOARD_SEMANTIC_HEIGHTS.regular);
        const frame = readFrameBridge(state.frames.at(-1)!);
        await act(async () => {
            await frame.onMessage({ version: 1, identity: frame.identity, sequence: 1, kind: 'ready', payload: { ready: true } });
            await frame.onMessage({ version: 1, identity: frame.identity, sequence: 2, kind: 'heightChanged', payload: { height: 2400 } });
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        expect(screen.findByType(WidgetFrame).props.viewportHeight).toBe(2400);
        expect(state.physicalMounts).toBe(1);
    });

    it('retains the same interactive body across independent theme and phone-width changes', async () => {
        const mountedRuntime = runtime();
        const renderWidget = () => <SessionWidgetHost sessionId="session-1" item={item}
            host="details" density="full" canEdit
            heightBounds={{ min: 96, max: 520 }} callerHostedHtmlRuntime={mountedRuntime}
            resolveSourceAvailability={() => ({ kind: 'available' })} testID="caller-widget" />;
        const originalTheme = Unistyles.useUnistyles();
        const theme = vi.spyOn(Unistyles, 'useUnistyles').mockReturnValue({ ...originalTheme, theme: lightTheme });
        const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1440, height: 1000, scale: 1, fontScale: 1 });
        const screen = await renderScreen(renderWidget());
        await awaitHostedBodies(screen);
        const frame = () => screen.tree.findByType('BrowserViewFrame');
        await act(async () => { frame().props.increment(); });
        const identity = readFrameBridge(state.frames.at(-1)!).identity;

        for (const [width, nextTheme] of [[1440, darkTheme], [390, darkTheme], [390, lightTheme], [1440, lightTheme]] as const) {
            theme.mockReturnValue({ ...originalTheme, theme: nextTheme });
            dimensions.mockReturnValue({ width, height: width === 390 ? 844 : 1000, scale: 1, fontScale: 1 });
            await screen.update(renderWidget());
            const host = screen.tree.root.findByType(SessionWidgetHost).findAll(node => node.props.onLayout
                && node.props.collapsable === false)[0]!;
            await act(async () => { host.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 300 } } }); });
            expect(frame().props.count).toBe(1);
            expect(state.physicalMounts).toBe(1);
            expect(readFrameBridge(state.frames.at(-1)!).identity).toEqual(identity);
        }
    });

    it('runs independent interactive HTML bodies on simultaneous visible surfaces', async () => {
        const mountedRuntime = runtime();
        const screen = await renderScreen(<>
            <SessionWidgetHost sessionId="session-1" item={item} host="details" density="full" canEdit
                callerHostedHtmlRuntime={mountedRuntime} resolveSourceAvailability={() => ({ kind: 'available' })} />
            <SessionWidgetHost sessionId="session-1" item={item} host="companion" density="compact" canEdit
                callerHostedHtmlRuntime={mountedRuntime} resolveSourceAvailability={() => ({ kind: 'available' })} />
        </>);
        await awaitHostedBodies(screen, 2);
        expect(state.physicalMounts).toBe(2);
        const frames = screen.tree.root.findAllByType('BrowserViewFrame');
        expect(frames).toHaveLength(2);
        const identities = state.frames.map(frame => readFrameBridge(frame).identity);
        expect(identities[0]).not.toEqual(identities[1]);
        await act(async () => { frames[0]!.props.increment(); });
        expect(frames[0]!.props.count).toBe(1);
        expect(frames[1]!.props.count).toBe(0);
        expect(state.physicalMounts).toBe(2);
    });

    it('mounts the neutral hosted frame with revision-bound lifecycle and the stored reduced API', async () => {
        await renderPlacement('details');
        expect(state.frames).toHaveLength(1);
        const first = state.frames[0]!;
        expect(first).toMatchObject({
            kind: 'webIframe',
            title: 'Caller card',
            sandbox: 'allow-scripts',
        });
        expect(String(first.html).match(/connect-src ([^;]*);/)?.[1]?.split(' ')).toContain('https://api.example.com');
        expect(first.html).toContain("frame-src 'none'; worker-src 'none'; object-src 'none'");
        expect(first.html).toEqual(expect.stringContaining('<main>caller-owned</main>'));
        const bridge = readFrameBridge(first);
        // The generated SDK necessarily contains plugin vocabulary; authority
        // comes from the host bootstrap, not a source-text substring.
        expect(bridge.bootstrap).not.toHaveProperty('authorPlugin');
        await bridge.onMessage({
            version: 1,
            identity: bridge.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        });
        await expect(bridge.onMessage({
            version: 1,
            identity: bridge.identity,
            sequence: 2,
            kind: 'hostApi',
            payload: {
                wireVersion: 1,
                kind: 'negotiate',
                identity: bridge.identity,
                apiRange: '^1.0.0',
            },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'negotiated', methods: ['context', 'watchContext', 'executeAction', 'notify'] },
        });
        await expect(bridge.onMessage({
            version: 1,
            identity: bridge.identity,
            sequence: 3,
            kind: 'hostApi',
            payload: {
                wireVersion: 1,
                kind: 'request',
                identity: bridge.identity,
                requestId: 'context-1',
                method: 'context',
            },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'result',
                result: {
                    surface: {
                        mount: { kind: 'embedded', role: 'callerHostedHtml', presentation: 'content' },
                        target: { kind: 'session', sessionId: 'session-1' },
                        accountEncryptionMode: 'plain',
                        theme: expect.any(Object),
                    },
                },
            },
        });
        await expect(bridge.onMessage({
            version: 1,
            identity: bridge.identity,
            sequence: 4,
            kind: 'hostApi',
            payload: {
                wireVersion: 1,
                kind: 'request',
                identity: bridge.identity,
                requestId: 'action-1',
                method: 'executeAction',
                payload: { action: 'session.board.item.remove', input: null },
            },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'denied' } },
        });

        standardCleanup();
        state.frames = [];
        await renderPlacement('inlineTranscript', item, false);
        expect(state.frames).toHaveLength(0);

        await renderPlacement('sidebar');
        expect(state.frames).toHaveLength(1);
        const secondBridge = readFrameBridge(state.frames[0]!);
        expect(secondBridge.identity).not.toEqual(bridge.identity);
    });

    it('keeps a ready body through same-surface updates and retires it on removal or source change', async () => {
        const mountedRuntime = runtime();
        const renderWidget = (
            renderedItem: SessionBoardItemProjection = item,
        ) => (
            <SessionWidgetHost
                sessionId="session-1"
                item={renderedItem}
                host="details"
                density="full"
                canEdit
                heightBounds={{ min: 96, max: 520 }}
                callerHostedHtmlRuntime={mountedRuntime}
                resolveSourceAvailability={() => ({ kind: 'available' })}
                testID="caller-widget"
            />
        );
        const screen = await renderScreen(renderWidget());
        await awaitHostedBodies(screen);
        expect(state.frames).toHaveLength(1);
        const generationG = readFrameBridge(state.frames[0]!);

        await act(async () => { screen.tree.findByType('BrowserViewFrame').props.increment(); });
        await screen.update(renderWidget({ ...item }));
        expect(readFrameBridge(state.frames.at(-1)!).identity).toEqual(generationG.identity);
        expect(screen.tree.findByType('BrowserViewFrame').props.count).toBe(1);
        expect(state.physicalMounts).toBe(1);

        await screen.update(renderWidget({ itemId: item.itemId, revision: null, state: { kind: 'removed' } }));
        expect(screen.tree.root.findAllByType('BrowserViewFrame')).toHaveLength(0);
        await expect(generationG.onMessage({
            version: 1,
            identity: generationG.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });

        state.frames = [];
        await screen.update(renderWidget());
        expect(state.frames).toHaveLength(1);
        const generationH = readFrameBridge(state.frames[0]!);
        expect(generationH.identity).not.toEqual(generationG.identity);

        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'hostedHtml') {
            throw new Error('caller-hosted HTML fixture must remain ready');
        }
        const changedCapabilities = {
            ...item,
            revision: 'revision-8',
            state: {
                kind: 'ready' as const,
                item: {
                    ...item.state.item,
                    source: {
                        ...item.state.item.source,
                        requestedCapabilities: {
                            ...item.state.item.source.requestedCapabilities,
                            hostMethods: ['context', 'notify'] as const,
                        },
                    },
                },
            },
        } satisfies SessionBoardItemProjection;
        state.frames = [];
        await screen.update(renderWidget(changedCapabilities));
        expect(state.frames).toHaveLength(1);
        const generationI = readFrameBridge(state.frames[0]!);
        expect(generationI.identity).not.toEqual(generationH.identity);
        await expect(generationH.onMessage({
            version: 1,
            identity: generationH.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });
    });

    it('binds each frame lifetime to the exact Home, Session, item and revision', async () => {
        const mountedRuntime = runtime();
        const renderWidget = (
            sessionId: string,
            renderedItem: SessionBoardItemProjection,
            runtimeOverride: CallerHostedHtmlRuntime = mountedRuntime,
        ) => (
            <SessionWidgetHost
                sessionId={sessionId}
                item={renderedItem}
                host="details"
                density="full"
                canEdit
                heightBounds={{ min: 96, max: 520 }}
                callerHostedHtmlRuntime={runtimeOverride}
                resolveSourceAvailability={() => ({ kind: 'available' })}
                testID="caller-widget"
            />
        );
        const screen = await renderScreen(renderWidget('session-1', item));
        const first = readFrameBridge(state.frames.at(-1)!);

        const nextItem = { ...item, itemId: 'caller-widget-2' } satisfies SessionBoardItemProjection;
        await screen.update(renderWidget('session-1', nextItem));
        const second = readFrameBridge(state.frames.at(-1)!);
        expect(second.identity).not.toEqual(first.identity);
        await expect(first.onMessage({
            version: 1,
            identity: first.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });

        storage.getState().applySessions([createSessionFixture({ id: 'session-2', serverId: 'home-a' })]);
        const nextHomeRuntime = runtime('session-2', 'server-identity-b');
        await screen.update(renderWidget('session-2', nextItem, nextHomeRuntime));
        const third = readFrameBridge(state.frames.at(-1)!);
        expect(third.identity).not.toEqual(second.identity);
        await expect(second.onMessage({
            version: 1,
            identity: second.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
    });

    it('renders a valid caller document and returns typed unsupported for an unavailable optional method', async () => {
        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'hostedHtml') {
            throw new Error('caller-hosted HTML fixture must remain ready');
        }
        const unavailableCapability = {
            ...item,
            state: {
                kind: 'ready' as const,
                item: {
                    ...item.state.item,
                    source: {
                        ...item.state.item.source,
                        requestedCapabilities: {
                            hostMethods: ['readResource'] as const,
                            resources: [{ pluginId: 'acme.preview', localId: 'status' }],
                        },
                    },
                },
            },
        } satisfies SessionBoardItemProjection;

        const screen = await renderPlacement('details', unavailableCapability);

        expect(screen.tree.root.findAllByType('BrowserViewFrame')).toHaveLength(1);
        expect(screen.findByTestId('caller-widget-hosted-html-unavailable')).toBeNull();
        const frame = readFrameBridge(state.frames.at(-1)!);
        await act(async () => {
            await frame.onMessage({ version: 1, identity: frame.identity, sequence: 1, kind: 'ready', payload: { ready: true } });
            await frame.onMessage({ version: 1, identity: frame.identity, sequence: 2, kind: 'hostApi', payload: {
                wireVersion: 1, kind: 'negotiate', identity: frame.identity, apiRange: '^1.0.0',
            } });
        });
        await expect(frame.onMessage({ version: 1, identity: frame.identity, sequence: 3, kind: 'hostApi', payload: {
            wireVersion: 1, kind: 'request', identity: frame.identity, requestId: 'unavailable-resource',
            method: 'readResource', payload: { resource: { pluginId: 'acme.preview', localId: 'status' } },
        } })).resolves.toMatchObject({ kind: 'result', payload: { kind: 'error', error: { code: 'unsupported_method' } } });
    });

    it('fails closed without a frame or authority bridge when secure mount identity entropy is unavailable, then recovers with a fresh identity', async () => {
        const { randomUUID } = await import('@/platform/randomUUID');
        const randomUuidSpy = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID');
        const mountedRuntime = runtime();
        const renderWidget = (renderedItem: SessionBoardItemProjection) => (
            <SessionWidgetHost
                sessionId="session-1"
                item={renderedItem}
                host="details"
                density="full"
                canEdit
                heightBounds={{ min: 96, max: 520 }}
                callerHostedHtmlRuntime={mountedRuntime}
                resolveSourceAvailability={() => ({ kind: 'available' })}
                testID="caller-widget"
            />
        );

        const screen = await renderScreen(renderWidget(item));
        expect(state.frames).toHaveLength(1);
        const firstBridge = readFrameBridge(state.frames[0]!);

        randomUuidSpy.mockImplementation(() => {
            throw new Error('secure_entropy_unavailable');
        });
        state.frames = [];
        await screen.update(renderWidget({ ...item, revision: 'revision-entropy-failure' }));

        expect(state.frames).toHaveLength(0);
        expect(screen.findByTestId('caller-widget-hosted-html-unavailable')).not.toBeNull();
        expect(screen.findByTestId(
            'caller-widget-hosted-html-unavailable-diagnostic-hosted_web_profile_isolation_unavailable',
        )).not.toBeNull();
        await expect(firstBridge.onMessage({
            version: 1,
            identity: firstBridge.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });

        randomUuidSpy.mockImplementation(randomUUID);
        state.frames = [];
        await screen.update(renderWidget({ ...item, revision: 'revision-entropy-recovered' }));

        expect(state.frames).toHaveLength(1);
        const recoveredBridge = readFrameBridge(state.frames[0]!);
        expect(recoveredBridge.identity).not.toEqual(firstBridge.identity);
        randomUuidSpy.mockRestore();
    });

    it('retires guest, load, and unexpected-navigation failures into typed Reload with a fresh mount identity', async () => {
        const screen = await renderPlacement('details');
        const firstFrame = state.frames.at(-1)!;
        const firstBridge = readFrameBridge(firstFrame);

        await act(async () => {
            await firstBridge.onMessage({ version: 1, identity: firstBridge.identity, sequence: 1,
                kind: 'error', payload: { message: 'guest failed' } });
        });
        expect(screen.findByTestId('caller-widget-hosted-html-error')).not.toBeNull();
        expect(screen.findByTestId('caller-widget-hosted-html-error-action')).not.toBeNull();

        state.frames = [];
        await act(async () => { await screen.pressByTestId('caller-widget-hosted-html-error-action'); });
        const reloadedFrame = state.frames.at(-1)!;
        const reloadedBridge = readFrameBridge(reloadedFrame);
        expect(reloadedBridge.identity.instanceId).toBe(firstBridge.identity.instanceId);
        expect(reloadedBridge.identity.mountNonce).not.toBe(firstBridge.identity.mountNonce);
        await expect(firstBridge.onMessage({
            version: 1,
            identity: firstBridge.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'error' });

        await act(async () => {
            await reloadedBridge.onMessage({
                version: 1,
                identity: reloadedBridge.identity,
                sequence: 1,
                kind: 'error',
                payload: { message: 'guest failed' },
            });
        });
        expect(screen.findByTestId('caller-widget-hosted-html-error')).not.toBeNull();

        state.frames = [];
        await act(async () => { await screen.pressByTestId('caller-widget-hosted-html-error-action'); });
        await act(async () => {
            (state.frames.at(-1)?.onError as (() => void) | undefined)?.();
        });
        expect(screen.findByTestId('caller-widget-hosted-html-error')).not.toBeNull();

        state.frames = [];
        await act(async () => { await screen.pressByTestId('caller-widget-hosted-html-error-action'); });
        await act(async () => {
            (state.frames.at(-1)?.onUnexpectedNavigation as (() => void) | undefined)?.();
        });
        expect(screen.findByTestId('caller-widget-hosted-html-error')).not.toBeNull();
    });

    it('waits for replacement source readiness without an arbitrary deadline and rejects the retired source', async () => {
        vi.useFakeTimers();
        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'hostedHtml') {
            throw new Error('caller-hosted HTML fixture must remain ready');
        }
        const mountedRuntime = runtime();
        const renderWidget = (renderedItem: SessionBoardItemProjection) => (
            <SessionWidgetHost
                sessionId="session-1"
                item={renderedItem}
                host="details"
                density="full"
                canEdit
                heightBounds={{ min: 96, max: 520 }}
                callerHostedHtmlRuntime={mountedRuntime}
                resolveSourceAvailability={() => ({ kind: 'available' })}
                testID="caller-widget"
            />
        );
        const screen = await renderScreen(renderWidget(item));
        const firstFrame = state.frames.at(-1)!;
        const firstBridge = readFrameBridge(firstFrame);
        await act(async () => {
            (firstFrame.onLoad as (() => void) | undefined)?.();
            await firstBridge.onMessage({
                version: 1,
                identity: firstBridge.identity,
                sequence: 1,
                kind: 'ready',
                payload: { ready: true },
            });
        });

        const changedSource = {
            ...item,
            revision: 'revision-8',
            state: {
                kind: 'ready' as const,
                item: {
                    ...item.state.item,
                    source: {
                        ...item.state.item.source,
                        source: artifactHtmlBundleFromBodyV1('<main>changed source</main>'),
                    },
                },
            },
        } satisfies SessionBoardItemProjection;
        state.frames = [];
        await screen.update(renderWidget(changedSource));
        const replacementFrame = state.frames.at(-1)!;
        const replacementBridge = readFrameBridge(replacementFrame);
        expect(replacementBridge.identity).not.toEqual(firstBridge.identity);

        await act(async () => {
            (replacementFrame.onLoad as (() => void) | undefined)?.();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(screen.findByTestId('caller-widget-hosted-html-error')).toBeNull();
        expect(readFrameBridge(state.frames.at(-1)!).identity).toEqual(replacementBridge.identity);
        await act(async () => {
            await replacementBridge.onMessage({ version: 1, identity: replacementBridge.identity, sequence: 1,
                kind: 'ready', payload: { ready: true } });
        });
        expect(screen.findByTestId('caller-widget-hosted-html-error')).toBeNull();
        await expect(firstBridge.onMessage({
            version: 1,
            identity: firstBridge.identity,
            sequence: 2,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
    });

    it('opens trusted external links through the shared frame without adding Host API grants', async () => {
        await renderPlacement('details');
        const frame = state.frames.at(-1)!;
        const bridge = readFrameBridge(frame);
        await expect(bridge.onMessage({
            version: 1,
            identity: bridge.identity,
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'ack' });
        await expect(bridge.onMessage({
            version: 1,
            identity: bridge.identity,
            sequence: 2,
            kind: 'hostApi',
            payload: {
                wireVersion: 1,
                kind: 'request',
                identity: bridge.identity,
                requestId: 'context-after-ready',
                method: 'context',
            },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', result: { surface: {
                mount: { kind: 'embedded', role: 'callerHostedHtml', presentation: 'content' },
                target: { kind: 'session', sessionId: 'session-1' }, accountEncryptionMode: 'plain',
            } } },
        });

        const webMessageBridge = frame.webMessageBridge as Readonly<{
            onMessage: (
                event: MessageEvent,
                receipt: Readonly<{ consumeTransientActivation: () => boolean }>,
            ) => Promise<unknown> | unknown;
        }>;
        const consumeTransientActivation = vi.fn(() => true);
        await expect(Promise.resolve(webMessageBridge.onMessage({
            data: {
                version: 1,
                identity: bridge.identity,
                sequence: 3,
                kind: 'openExternal',
                payload: { url: 'https://example.com/docs' },
            },
            origin: 'null',
        } as MessageEvent, { consumeTransientActivation }))).resolves.toMatchObject({ kind: 'ack' });

        expect(consumeTransientActivation).toHaveBeenCalled();
        expect(state.openedExternalUrls).toEqual(['https://example.com/docs']);
    });
});
