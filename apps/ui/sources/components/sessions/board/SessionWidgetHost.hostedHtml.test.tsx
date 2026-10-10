import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PluginHostedWebBridgeEnvelopeV1,
    UiSurfaceExecutableApprovalKeyV1,
} from '@happier-dev/protocol/plugins/ui';

import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import type { SessionBoardItemProjection, SessionBoardMountHost } from '@/sync/domains/session/board';

const state = vi.hoisted(() => ({
    frames: [] as Record<string, unknown>[],
    approvals: [] as Array<Readonly<{ approval: UiSurfaceExecutableApprovalKeyV1; key: string }>>,
    requests: [] as string[],
    approved: true,
    approvedKeys: [] as string[],
    revokedKeys: [] as string[],
    controllersCreated: 0,
    controllersDisposed: 0,
    session: null as ReturnType<typeof createSessionFixture> | null,
    openedExternalUrls: [] as string[],
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
        state.frames.push(props.engine);
        return React.createElement('BrowserViewFrame');
    },
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/store/hooks')>()),
    useSession: () => state.session,
    useSessionServerId: () => 'home-a',
    useSettings: () => ({}),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    useSessionStatus: () => ({ state: 'waiting' }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({ status: 'ready', features: {} }),
    resolveRuntimeFeatureDecisionFromSnapshot: () => ({ state: 'enabled' }),
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

function runtime(): CallerHostedHtmlRuntime {
    return {
        serverIdentityId: 'server-identity-a',
        accountId: 'account-a',
        hostOrigin: 'https://app.example.com',
        // A trusted installed-plugin-only method is deliberately present in the
        // runtime ceiling. The caller manifest must still expose only its exact
        // reviewed request.
        admittedHostMethods: ['context', 'executeAction', 'notify', 'readClipboard'],
        isApproved: (approval, approvalKey) => {
            state.approvals.push({ approval, key: approvalKey });
            return state.approved;
        },
        approve: (_approval, key) => { state.approvedKeys.push(key); },
        revoke: (_approval, key) => { state.revokedKeys.push(key); },
        createRequestController: () => {
            state.controllersCreated += 1;
            return {
                handleRequest: async (request) => {
                    state.requests.push(request.method);
                    return null;
                },
                dispose: () => { state.controllersDisposed += 1; },
            };
        },
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
    return { identity: config.identity, onMessage };
}

async function renderPlacement(
    host: SessionBoardMountHost,
    primaryHost: SessionBoardMountHost | null,
    renderedItem: SessionBoardItemProjection = item,
    executableCurrentness: 'current' | 'stale' | 'offline' | 'unverified' = 'current',
) {
    const { SessionWidgetHost } = await import('./SessionWidgetHost');
    return await renderScreen(<SessionWidgetHost
        sessionId="session-1"
        item={renderedItem}
        host={host}
        primaryHost={primaryHost}
        density={host === 'sidebar' ? 'compact' : 'full'}
        canEdit
        executableCurrentness={executableCurrentness}
        heightBounds={{ min: 96, max: 520 }}
        callerHostedHtmlRuntime={runtime()}
        resolveSourceAvailability={() => ({ kind: 'available' })}
        testID="caller-widget"
    />);
}

describe('SessionWidgetHost caller-authored hosted HTML', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        standardCleanup();
        state.frames = [];
        state.approvals = [];
        state.requests = [];
        state.approved = true;
        state.approvedKeys = [];
        state.revokedKeys = [];
        state.controllersCreated = 0;
        state.controllersDisposed = 0;
        state.openedExternalUrls = [];
        state.session = createSessionFixture({ id: 'session-1' });
    });

    it('mounts the neutral hosted frame with revision-bound lifecycle, exact approval and reduced API', async () => {
        await renderPlacement('details', 'details');
        expect(state.frames).toHaveLength(1);
        const first = state.frames[0]!;
        expect(first).toMatchObject({
            kind: 'webIframe',
            title: 'Caller card',
            sandbox: 'allow-scripts',
        });
        expect(first.html).toEqual(expect.stringContaining(
            "connect-src https://api.example.com; frame-src 'none'; worker-src 'none'; object-src 'none'",
        ));
        expect(first.html).toEqual(expect.stringContaining('<main>caller-owned</main>'));
        expect(JSON.stringify(first)).not.toContain('pluginId');
        expect(state.approvals).toHaveLength(1);
        expect(state.approvals[0]!.approval).toMatchObject({
            serverIdentityId: 'server-identity-a',
            accountId: 'account-a',
            approvalSubject: '["session-record","server-identity-a","session-1","surface/item.v1","caller-widget-1"]',
        });

        const bridge = readFrameBridge(first);
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
            payload: { kind: 'negotiated', methods: ['context', 'executeAction', 'notify'] },
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
                        callerHostedHtml: {
                            recordRevision: 'revision-7',
                            capabilityManifest: {
                                version: 1,
                                advertisedHostMethods: ['context', 'executeAction', 'notify'],
                            },
                        },
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
        expect(state.requests).toEqual([]);

        standardCleanup();
        state.frames = [];
        await renderPlacement('sidebar', 'details');
        expect(state.frames).toHaveLength(0);

        await renderPlacement('sidebar', 'sidebar');
        expect(state.frames).toHaveLength(1);
        const secondBridge = readFrameBridge(state.frames[0]!);
        expect(secondBridge.identity).not.toEqual(bridge.identity);
        expect(state.approvals.at(-1)?.key).toBe(state.approvals[0]?.key);
    });

    it('retires the executable bridge while retained Board bytes are stale and remounts a fresh lifetime after reconnect', async () => {
        const { SessionWidgetHost } = await import('./SessionWidgetHost');
        const mountedRuntime = runtime();
        const renderWidget = (
            executableCurrentness: 'current' | 'stale' | 'offline' | 'unverified',
            renderedItem: SessionBoardItemProjection = item,
        ) => (
            <SessionWidgetHost
                sessionId="session-1"
                item={renderedItem}
                host="details"
                primaryHost="details"
                density="full"
                canEdit
                executableCurrentness={executableCurrentness}
                heightBounds={{ min: 96, max: 520 }}
                callerHostedHtmlRuntime={mountedRuntime}
                resolveSourceAvailability={() => ({ kind: 'available' })}
                testID="caller-widget"
            />
        );
        const screen = await renderScreen(renderWidget('current'));
        expect(state.frames).toHaveLength(1);
        const generationG = readFrameBridge(state.frames[0]!);

        await screen.update(renderWidget('stale'));
        expect(screen.findByTestId('caller-widget-executable-stale')).not.toBeNull();
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
        await screen.update(renderWidget('current'));
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
        await screen.update(renderWidget('current', changedCapabilities));
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
        const { SessionWidgetHost } = await import('./SessionWidgetHost');
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
                primaryHost="details"
                density="full"
                canEdit
                executableCurrentness="current"
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

        const nextHomeRuntime = { ...mountedRuntime, serverIdentityId: 'server-identity-b' };
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

    it('reviews requested capabilities as localized rows, keeps machine identity on the diagnostics channel, and exposes revoke after mounting', async () => {
        state.approved = false;
        const review = await renderPlacement('details', 'details');
        expect(state.frames).toHaveLength(0);
        const text = review.getTextContent();
        expect(text).toContain(t('sessionBoard.hostedHtmlApproval.title'));
        expect(text).toContain(t('sessionBoard.hostedHtmlApproval.body'));
        expect(text).toContain(t('sessionBoard.hostedHtmlApproval.actions', { count: 1 }));
        expect(text).toContain(t('sessionBoard.hostedHtmlApproval.loadsFrom', { origin: 'https://api.example.com' }));
        // This fixture asks for no resources and no message sending: no row is invented for them.
        expect(text).not.toContain(t('sessionBoard.hostedHtmlApproval.sendMessages'));
        expect(text).not.toContain(t('sessionBoard.hostedHtmlApproval.resources', { count: 0 }));
        // The exact revision, fingerprint and manifest are QA diagnostics, never spoken copy.
        expect(text).not.toContain('revision-7');
        expect(text).not.toContain('{');
        expect(text).not.toMatch(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/);
        expect(review.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('caller-widget-hosted-html-approval-diagnostic-revision-7'))).not.toHaveLength(0);
        await review.pressByTestId('caller-widget-hosted-html-approval-action');
        expect(state.approvedKeys).toEqual([state.approvals[0]!.key]);

        standardCleanup();
        state.approved = true;
        const mounted = await renderPlacement('details', 'details');
        expect(state.frames).toHaveLength(1);
        await mounted.pressByTestId('caller-widget-hosted-html-revoke-approval');
        expect(state.revokedKeys).toEqual([state.approvals.at(-1)!.key]);
    });

    it('names message sending as its own fixed row only when the view asks for it', async () => {
        state.approved = false;
        const review = await renderPlacement('details', 'details', {
            ...item,
            state: {
                kind: 'ready' as const,
                item: {
                    ...item.state.item,
                    source: {
                        ...item.state.item.source,
                        requestedCapabilities: {
                            ...item.state.item.source.requestedCapabilities,
                            actions: ['session.message.send', 'session.board.get'] as const,
                        },
                    },
                },
            },
        } satisfies SessionBoardItemProjection);
        const text = review.getTextContent();
        expect(text).toContain(t('sessionBoard.hostedHtmlApproval.sendMessages'));
        // Message sending is not double-counted as a generic action.
        expect(text).toContain(t('sessionBoard.hostedHtmlApproval.actions', { count: 1 }));
    });

    it('lets the person decline for now without recording a decision and review again later', async () => {
        state.approved = false;
        const review = await renderPlacement('details', 'details');
        await review.pressByTestIdAsync('caller-widget-hosted-html-approval-secondary-action');
        expect(state.approvedKeys).toEqual([]);
        expect(state.revokedKeys).toEqual([]);
        expect(state.frames).toHaveLength(0);
        expect(review.findByTestId('caller-widget-hosted-html-approval')).toBeNull();
        expect(review.getTextContent()).toContain(t('sessionBoard.hostedHtmlApproval.declined.title'));
        await review.pressByTestIdAsync('caller-widget-hosted-html-declined-action');
        expect(review.findByTestId('caller-widget-hosted-html-approval')).not.toBeNull();
        expect(state.approvedKeys).toEqual([]);
    });

    it('reuses approval across equivalent record revisions and invalidates it when capabilities change', async () => {
        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'hostedHtml') {
            throw new Error('caller-hosted HTML fixture must remain ready');
        }
        await renderPlacement('details', 'details');
        const originalKey = state.approvals.at(-1)!.key;

        standardCleanup();
        state.frames = [];
        await renderPlacement('details', 'details', { ...item, revision: 'revision-8' });
        expect(state.frames).toHaveLength(1);
        expect(state.approvals.at(-1)!.key).toBe(originalKey);

        standardCleanup();
        state.frames = [];
        const changedCapabilities = {
            ...item,
            revision: 'revision-9',
            state: {
                kind: 'ready' as const,
                item: {
                    ...item.state.item,
                    source: {
                        ...item.state.item.source,
                        requestedCapabilities: {
                            ...item.state.item.source.requestedCapabilities,
                            hostMethods: ['context', 'executeAction', 'notify', 'readResource'] as const,
                            resources: [{ pluginId: 'acme.preview', localId: 'status' }],
                        },
                    },
                },
            },
        } satisfies SessionBoardItemProjection;
        await renderPlacement('details', 'details', changedCapabilities);
        expect(state.approvals.at(-1)!.key).not.toBe(originalKey);
    });

    it('keeps rejected caller content visible as a typed unavailable state instead of a blank card', async () => {
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

        const screen = await renderPlacement('details', 'details', unavailableCapability);

        expect(state.frames).toHaveLength(0);
        expect(screen.findByTestId('caller-widget-hosted-html-unavailable')).not.toBeNull();
        expect(screen.findByTestId(
            'caller-widget-hosted-html-unavailable-diagnostic-capability_request_invalid',
        )).not.toBeNull();
    });

    it('fails closed without a frame or authority bridge when secure mount identity entropy is unavailable, then recovers with a fresh identity', async () => {
        const { randomUUID } = await import('@/platform/randomUUID');
        const randomUuidSpy = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID');
        const { SessionWidgetHost } = await import('./SessionWidgetHost');
        const mountedRuntime = runtime();
        const renderWidget = (renderedItem: SessionBoardItemProjection) => (
            <SessionWidgetHost
                sessionId="session-1"
                item={renderedItem}
                host="details"
                primaryHost="details"
                density="full"
                canEdit
                executableCurrentness="current"
                heightBounds={{ min: 96, max: 520 }}
                callerHostedHtmlRuntime={mountedRuntime}
                resolveSourceAvailability={() => ({ kind: 'available' })}
                testID="caller-widget"
            />
        );

        const screen = await renderScreen(renderWidget(item));
        expect(state.frames).toHaveLength(1);
        const firstBridge = readFrameBridge(state.frames[0]!);
        expect(state.controllersCreated).toBe(1);
        const approvalCount = state.approvals.length;

        randomUuidSpy.mockImplementation(() => {
            throw new Error('secure_entropy_unavailable');
        });
        state.frames = [];
        await screen.update(renderWidget({ ...item, revision: 'revision-entropy-failure' }));

        expect(state.frames).toHaveLength(0);
        expect(state.controllersCreated).toBe(1);
        expect(state.controllersDisposed).toBe(1);
        expect(state.approvals).toHaveLength(approvalCount);
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
        expect(state.controllersCreated).toBe(2);
        randomUuidSpy.mockRestore();
    });

    it('retires guest, load, timeout, and unexpected-navigation failures into typed Reload with a fresh mount identity', async () => {
        vi.useFakeTimers();
        const screen = await renderPlacement('details', 'details');
        const firstFrame = state.frames.at(-1)!;
        const firstBridge = readFrameBridge(firstFrame);

        await act(async () => {
            (firstFrame.onLoad as (() => void) | undefined)?.();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
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

    it('starts a fresh ready timeout when the exact record source changes after the prior frame was ready', async () => {
        vi.useFakeTimers();
        if (item.state.kind !== 'ready' || item.state.item.source.kind !== 'hostedHtml') {
            throw new Error('caller-hosted HTML fixture must remain ready');
        }
        const { SessionWidgetHost } = await import('./SessionWidgetHost');
        const mountedRuntime = runtime();
        const renderWidget = (renderedItem: SessionBoardItemProjection) => (
            <SessionWidgetHost
                sessionId="session-1"
                item={renderedItem}
                host="details"
                primaryHost="details"
                density="full"
                canEdit
                executableCurrentness="current"
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
        expect(screen.findByTestId('caller-widget-hosted-html-error')).not.toBeNull();
        await expect(firstBridge.onMessage({
            version: 1,
            identity: firstBridge.identity,
            sequence: 2,
            kind: 'ready',
            payload: { ready: true },
        })).resolves.toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
    });

    it('denies identity-valid activated external navigation while admitted Host API methods still work', async () => {
        await renderPlacement('details', 'details');
        const frame = state.frames.at(-1)!;
        expect(String(frame.html)).not.toContain('__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__');
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
            payload: { kind: 'result', result: { surface: { callerHostedHtml: { recordRevision: 'revision-7' } } } },
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
        } as MessageEvent, { consumeTransientActivation }))).resolves.toBeUndefined();

        expect(consumeTransientActivation).not.toHaveBeenCalled();
        expect(state.openedExternalUrls).toEqual([]);
    });
});
