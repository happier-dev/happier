import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionAccessFixture, createSessionFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginUiHostApiSurfaceContextV1Schema, type PluginHostedWebBridgeEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_BROWSER_PROJECTION } from '@/sync/domains/plugins/browser/targets';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';

const platformState = vi.hoisted(() => ({ current: 'web' }));
const frameAvailability = vi.hoisted(() => ({ current: true }));
const credentials = vi.hoisted(() => new Map<string, string>());
const credentialListeners = vi.hoisted(() => new Set<(event: HomeCredentialMutationEvent) => void>());
const frames = vi.hoisted(() => [] as Record<string, unknown>[]);

// The physical browser frame is the platform boundary; keep the runtime,
// adapter, shared frame host and canonical Host API bridge real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: Record<string, unknown> }>) => {
        const [document] = React.useState(() => ({}));
        frames.push(props.engine);
        return React.createElement('BrowserViewFrame', { testID: 'physical-caller-frame', document });
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() { return platformState.current; },
            select: <T,>(values: Readonly<{ web?: T; ios?: T; android?: T; default?: T }>) => (
                values[platformState.current as 'web' | 'ios' | 'android'] ?? values.default
            ),
        },
    });
});

// Secure credential storage is the external boundary. Account retirement,
// Session projection, local settings, Front Door and request controllers stay real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (_url, options) => {
                const accountId = credentials.get(options?.serverId ?? '');
                return accountId ? {
                    token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
                } : null;
            },
        },
        subscribeHomeCredentialMutations: (listener) => {
            credentialListeners.add(listener);
            return () => { credentialListeners.delete(listener); };
        },
    });
});

vi.mock('../framed/hostOrigin', () => ({
    resolveHostedFrameHostOrigin: () => 'https://app.happier.dev',
}));

vi.mock('./hostedInlineDocumentFrameCapability', () => ({
    isHostedInlineDocumentFrameAvailable: () => frameAvailability.current,
}));

import { useSessionCallerHostedHtmlRuntime } from './useSessionCallerHostedHtmlRuntime';
import { HostedHtmlSurfaceAdapter } from './HostedHtmlSurfaceAdapter';
import { ApprovalVisualPreview } from '@/components/approvals/ApprovalVisualPreview';
import { resolveApprovalVisualPreview } from '@/components/approvals/approvalFieldValues';
import { SESSION_BOARD_SEMANTIC_HEIGHTS } from '@/components/sessions/board/sessionBoardItemHeight';
import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApiWireEnvelopeV1 } from '@happier-dev/protocol/plugins/ui/client';

const pluginRuntime: SessionPluginRuntimeState = {
    phase: 'current', interactionEnabled: true, machineId: 'machine-a', serverId: 'srv_home-a',
    platform: 'web', pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1 }, pluginBrowserProjection: null,
    accountLifetime: null,
};

const source = artifactHtmlBundleFromBodyV1('<main>Same document</main>');
const contextCapabilities = { hostMethods: ['context', 'watchContext'] };

function CallerSurface(props: Readonly<{ runtime: SessionPluginRuntimeState; value: string; requestedCapabilities?: unknown }>) {
    const runtime = useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a', props.runtime);
    return runtime ? <HostedHtmlSurfaceAdapter
        sessionId="session-a" title="Caller" recordRevision="revision-a" approvalSubject="item-a"
        source={source} requestedCapabilities={props.requestedCapabilities ?? contextCapabilities}
        target={{ kind: 'session', sessionId: 'session-a' }} runtime={runtime} testID="caller-surface"
    /> : null;
}

function readFrame(frame: Record<string, unknown>) {
    const encoded = String(frame.html).match(/Object\.freeze\((\{.*?\})\),writable:false/)?.[1];
    if (!encoded) throw new Error('expected_caller_frame_bootstrap');
    const { identity } = JSON.parse(encoded) as { identity: { instanceId: string; mountNonce: string } };
    const bridge = frame.webMessageBridge as {
        attachHostMessages: (send: (message: unknown) => void) => () => void;
        onMessage: (event: MessageEvent, receipt: { consumeTransientActivation: () => boolean }) => unknown;
    };
    const send = (message: PluginHostedWebBridgeEnvelopeV1) => bridge.onMessage(
        { data: message, origin: 'null' } as MessageEvent,
        { consumeTransientActivation: () => false },
    );
    return { identity, bridge, send };
}

function publishSession(serverId = 'srv_home-a', sessionId = 'session-a') {
    storage.setState({ sessions: {
        [sessionId]: createSessionFixture({ id: sessionId, serverId }),
    } });
}

afterEach(() => { standardCleanup(); credentials.clear(); vi.unstubAllGlobals(); invalidateAccountEncryptionModeCache(); });

describe('useSessionCallerHostedHtmlRuntime', () => {
    it('delivers a policy refusal to the real guest bridge instead of reporting an internal host failure', async () => {
        storage.setState(state => ({ settingsScope: { serverId: 'srv_home-a', accountId: 'account:srv_home-a' },
            settings: { ...state.settings, actionsSettingsV1: { v: 1, actions: {} } },
            sessions: { ...state.sessions, 'session-a': { ...state.sessions['session-a']!, access: createSessionAccessFixture('edit') } },
        }));
        const screen = await renderScreen(<CallerSurface runtime={pluginRuntime} value="foreign"
            requestedCapabilities={{ hostMethods: ['context', 'executeAction'], actions: ['session.message.send', 'session.stop'] }} />);
        await vi.waitFor(() => expect(screen.findByTestId('physical-caller-frame')).not.toBeNull());
        const guest = readFrame(frames.at(-1)!);
        await act(async () => {
            await guest.send({ version: 1, identity: guest.identity, sequence: 1, kind: 'ready', payload: { ready: true } });
            await guest.send({ version: 1, identity: guest.identity, sequence: 2, kind: 'hostApi', payload: {
                wireVersion: 1, kind: 'negotiate', identity: guest.identity, apiRange: '^1.0.0',
            } });
            let sequence = 2;
            for (const action of ['session.message.send', 'session.stop'] as const) {
                expect(await guest.send({ version: 1, identity: guest.identity, sequence: ++sequence, kind: 'hostApi', payload: {
                    wireVersion: 1, kind: 'request', identity: guest.identity, requestId: action, method: 'executeAction',
                    payload: { action, input: action === 'session.message.send' ? { message: 'Blocked' } : { sessionId: 'session-a' } },
                } })).toMatchObject({ kind: 'result', payload: { kind: 'error', error: { code: 'action_disabled' } } });
            }
        });
    });
    it('supplies current Session ownership to policy without letting a still-readable recipient borrow owner access', async () => {
        storage.setState({ settingsScope: { serverId: 'srv_home-a', accountId: 'account:srv_home-a' } });
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a', pluginRuntime));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const controller = hook.getCurrent()!.createRequestController(() => {});
        const read = () => controller.handleRequest({ requestId: 'ownership', method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'missing' } } });
        try {
            // The own-Session call reaches the real declaration reader (there is no such Resource).
            await expect(read()).rejects.toThrow('plugin_resource_not_found');
            await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
                'session-a': { ...state.sessions['session-a']!, access: createSessionAccessFixture('edit') },
            } })); });
            expect(hook.getCurrent()).not.toBeNull();
            await expect(read()).resolves.toMatchObject({ code: 'action_disabled' });
            await act(async () => { storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: { v: 1, actions: {}, callerSurfacePolicies: { foreign_session_html: {
                    'acme.preview/resources/missing': 'allowed',
                } } },
            } })); });
            await expect(read()).rejects.toThrow('plugin_resource_not_found');
        } finally { controller.dispose(); }
    });
    beforeEach(async () => {
        await act(async () => { await loadPluginUiHostSupport(); });
        // The physical document lazily loads its real guest bootstrap. Resolve
        // that module before testing held Account-mode readiness so a cold
        // Vitest transform is not mistaken for a still-pending mode read.
        await import('@/components/plugins/hostedWeb/guestBootstrap.generated');
        platformState.current = 'web';
        frameAvailability.current = true;
        frames.length = 0;
        // Only HTTP is replaced: exact-Home account capture, mode parsing and disclosure stay real.
        vi.stubGlobal('fetch', async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname !== '/v1/account/encryption') throw new Error(`unexpected_request:${url}`);
            return new Response(JSON.stringify({ mode: url.hostname.includes('home-b') ? 'e2ee' : 'plain', updatedAt: 1 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        for (const home of ['srv_home-a', 'srv_home-b']) {
            credentials.set(home, `account:${home}`);
            await upsertServerProfile({ serverUrl: `https://${home}.example.test`, name: home, source: 'manual' });
            await setServerProfileIdentityForUrl(`https://${home}.example.test`, home);
        }
        storage.setState(storage.getInitialState(), true);
        publishSession();
        expect(await resolveServerCredentialAccountScope('srv_home-a')).toMatchObject({
            kind: 'bound', scope: { serverId: 'srv_home-a', accountId: 'account:srv_home-a' },
        });
    });

    it.each(['fixed', 'auto'] as const)('reserves the declared %s approval height while account mode is pending', async (mode) => {
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        vi.stubGlobal('fetch', async () => {
            await pending;
            return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
        });
        const preview = resolveApprovalVisualPreview({ actionId: 'session.board.item.upsert', actionArgs: {
            item: { title: 'Build health', height: mode === 'fixed'
                ? { mode: 'fixed', size: 'compact' } : { mode: 'auto', fallback: 'compact' },
                source: { kind: 'hostedHtml', source } },
        } });
        if (!preview) throw new Error('expected_html_preview');
        const screen = await renderScreen(<ApprovalVisualPreview artifactId="approval-pending" serverId="srv_home-a"
            preview={preview} testID="preview" />);
        try {
            expect(screen.findByTestId('physical-caller-frame')).toBeNull();
            expect(screen.findByTestId('preview-row')).not.toBeNull();
            expect(screen.findByTestId('preview')?.props.style.height).toBe(SESSION_BOARD_SEMANTIC_HEIGHTS.compact);
        } finally {
            await act(async () => { release(); });
        }
        await vi.waitFor(() => expect(screen.findByTestId('physical-caller-frame')).not.toBeNull());
        expect(screen.findByTestId('preview')?.props.style.height).toBe(SESSION_BOARD_SEMANTIC_HEIGHTS.compact);
        const guest = readFrame(frames.at(-1)!);
        await act(async () => {
            await guest.send({ version: 1, identity: guest.identity, sequence: 1, kind: 'ready', payload: { ready: true } });
            await guest.send({ version: 1, identity: guest.identity, sequence: 2, kind: 'heightChanged', payload: { height: 116 } });
        });
        await flushHookEffects({ frames: 1 });
        expect(screen.findByTestId('preview')?.props.style.height).toBe(mode === 'fixed'
            ? SESSION_BOARD_SEMANTIC_HEIGHTS.compact : 116);
    });

    it('opens an inert approval preview without a Session or plugin runtime through the strict guest client', async () => {
        storage.setState({ sessions: {} });
        const screen = await renderScreen(<ApprovalVisualPreview artifactId="approval-a" serverId="srv_home-a"
            preview={{ kind: 'html', title: 'Review', source, requestedCapabilities: { network: 'none' } }} testID="preview" />);
        await vi.waitFor(() => expect(screen.findByTestId('physical-caller-frame')).not.toBeNull());
        const frame = frames.at(-1)!;
        expect(String(frame.html).match(/connect-src ([^;]*);/)?.[1]).toBe('data:');
        const guest = readFrame(frame);
        let sequence = 0;
        await act(async () => {
            await guest.send({ version: 1, identity: guest.identity, sequence: ++sequence, kind: 'ready', payload: { ready: true } });
        });
        const listeners = new Set<(message: unknown) => void>();
        const detach = guest.bridge.attachHostMessages((message) => {
            if (message && typeof message === 'object' && 'kind' in message && message.kind === 'hostApi' && 'payload' in message) {
                for (const listener of listeners) listener(message.payload);
            }
        });
        // The isolated guest's transport is the boundary; negotiate and decode
        // using the public SDK client, without inventing an installed plugin.
        vi.stubGlobal('__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__', {
            identity: guest.identity,
            transport: {
                send: async (payload: PluginUiHostApiWireEnvelopeV1) => {
                    const response = await guest.send({ version: 1, identity: guest.identity, sequence: ++sequence, kind: 'hostApi', payload });
                    if (response && typeof response === 'object' && 'payload' in response) {
                        for (const listener of listeners) listener(response.payload);
                    }
                },
                subscribe: (listener: (message: unknown) => void) => {
                    listeners.add(listener);
                    return { dispose: () => { listeners.delete(listener); } };
                },
            },
        });
        const api = await createPluginUiHostApiClient();
        const context = await api.context();
        expect(PluginUiHostApiSurfaceContextV1Schema.safeParse(context).success).toBe(true);
        expect(context).toMatchObject({ target: { kind: 'app' }, accountEncryptionMode: 'plain', theme: expect.any(Object) });
        const watch = await api.watchContext(() => {});
        for (const method of ['executeAction', 'readResource'] as const) {
            expect(await guest.send({ version: 1, identity: guest.identity, sequence: ++sequence, kind: 'hostApi', payload: {
                wireVersion: 1, kind: 'request', identity: guest.identity, requestId: `denied:${method}`, method, payload: {},
            } })).toMatchObject({ kind: 'result', payload: { kind: 'error', error: { code: 'unsupported_method' } } });
        }
        expect(await guest.send({ version: 1, identity: guest.identity, sequence: ++sequence, kind: 'hostApi', payload: {
            wireVersion: 1, kind: 'subscribe', identity: guest.identity, requestId: 'denied:watchResource',
            method: 'watchResource', subscriptionId: 'denied-resource', payload: {},
        } })).toMatchObject({ kind: 'result', payload: { kind: 'error', error: { code: 'unsupported_method' } } });
        expect(screen.findByTestId('preview-hosted-html-unavailable')).toBeNull();
        watch.dispose();
        detach();
    });

    it('replays an admitted stored visual on a fresh viewer without device-local consent', async () => {
        const capabilities = { hostMethods: ['context', 'watchContext'], networkOrigins: ['https://status.example.test'] };
        const firstViewer = await renderScreen(<CallerSurface runtime={pluginRuntime} value="stored" requestedCapabilities={capabilities} />);
        await vi.waitFor(() => expect(firstViewer.findByTestId('physical-caller-frame')).not.toBeNull());
        const first = readFrame(frames.at(-1)!);
        expect(firstViewer.findByTestId('caller-surface-approval')).toBeNull();
        expect(firstViewer.findByTestId('caller-surface-revoke-approval')).toBeNull();
        await firstViewer.unmount();
        const secondViewer = await renderScreen(<CallerSurface runtime={pluginRuntime} value="stored" requestedCapabilities={capabilities} />);
        await vi.waitFor(() => expect(secondViewer.findByTestId('physical-caller-frame')).not.toBeNull());
        const second = readFrame(frames.at(-1)!);
        expect(second.identity).not.toEqual(first.identity);
        expect(secondViewer.findByTestId('caller-surface-approval')).toBeNull();
        expect(await first.send({ version: 1, identity: first.identity, sequence: 1, kind: 'ready', payload: { ready: true } }))
            .toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
    });

    it('keeps the physical mount across unrelated browser projection updates but retires it on credential loss', async () => {
        const screen = await renderScreen(<CallerSurface runtime={pluginRuntime} value="before" />);
        await vi.waitFor(() => expect(screen.findByTestId('physical-caller-frame')).not.toBeNull());
        const before = readFrame(frames.at(-1)!);
        const physicalFrame = screen.findByTestId('physical-caller-frame');
        const document = physicalFrame!.props.document;
        const events: unknown[] = [];
        const detach = before.bridge.attachHostMessages((message) => events.push(message));
        await act(async () => {
            await before.send({ version: 1, identity: before.identity, sequence: 1, kind: 'ready', payload: { ready: true } });
            await before.send({ version: 1, identity: before.identity, sequence: 2, kind: 'hostApi', payload: {
                wireVersion: 1, kind: 'negotiate', identity: before.identity, apiRange: '^1.0.0',
            } });
            expect(await before.send({ version: 1, identity: before.identity, sequence: 3, kind: 'hostApi', payload: {
                wireVersion: 1, kind: 'subscribe', identity: before.identity, requestId: 'watch',
                method: 'watchContext', subscriptionId: 'live-context',
            } })).toMatchObject({ kind: 'result', payload: { kind: 'result' } });
        });
        await screen.update(<CallerSurface
            runtime={{ ...pluginRuntime, pluginBrowserProjection: { ...EMPTY_PLUGIN_BROWSER_PROJECTION } }} value="after"
        />);
        expect(readFrame(frames.at(-1)!).identity).toEqual(before.identity);
        expect(screen.findByTestId('physical-caller-frame')).toBe(physicalFrame);
        expect(screen.findByTestId('physical-caller-frame')!.props.document).toBe(document);
        // Parent-only bags are not public context, and an equivalent canonical
        // snapshot must neither disconnect nor publish a spurious update.
        expect(events).not.toContainEqual(expect.objectContaining({ kind: 'disconnected' }));
        await screen.update(<CallerSurface runtime={{ ...pluginRuntime, machineId: 'machine-b' }} value="after" />);
        const replacement = readFrame(frames.at(-1)!);
        expect(replacement.identity).not.toEqual(before.identity);
        expect(await before.send({ version: 1, identity: before.identity, sequence: 4, kind: 'ready', payload: { ready: true } }))
            .toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
        await act(async () => {
            credentials.delete('srv_home-a');
            for (const listener of credentialListeners) listener({
                kind: 'credentials_removed', serverId: 'srv_home-a', serverUrl: 'https://srv_home-a.example.test',
            });
        });
        expect(screen.findByTestId('physical-caller-frame')).toBeNull();
        expect(await replacement.send({ version: 1, identity: replacement.identity, sequence: 1, kind: 'ready', payload: { ready: true } }))
            .toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
        detach();
    });

    it('retires the old policy frame before replaying a narrowed stored policy', async () => {
        const screen = await renderScreen(<CallerSurface runtime={pluginRuntime} value="same"
            requestedCapabilities={{ hostMethods: ['context', 'notify'], networkOrigins: ['https://status.example.test'] }} />);
        await vi.waitFor(() => expect(screen.findByTestId('physical-caller-frame')).not.toBeNull());
        const original = readFrame(frames.at(-1)!);
        expect(String(frames.at(-1)!.html).match(/connect-src ([^;]*);/)?.[1]?.split(' '))
            .toEqual(['data:', 'https://status.example.test']);
        await screen.update(<CallerSurface runtime={pluginRuntime} value="same" requestedCapabilities={{ hostMethods: ['context'] }} />);
        expect(screen.findByTestId('physical-caller-frame')).not.toBeNull();
        expect(String(frames.at(-1)!.html).match(/connect-src ([^;]*);/)?.[1]?.split(' '))
            .toEqual(['data:']);
        expect(readFrame(frames.at(-1)!).identity).not.toEqual(original.identity);
        expect(await original.send({ version: 1, identity: original.identity, sequence: 1, kind: 'ready', payload: { ready: true } }))
            .toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
    });

    it('retires when the canonical normalized Session loses read access and fails closed without that projection', async () => {
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const admitted = hook.getCurrent()!;
        await act(async () => { storage.setState((state) => ({ sessions: {
            ...state.sessions,
            'session-a': { ...state.sessions['session-a']!, access: createSessionAccessFixture('view', { readTranscript: false }) },
        } })); });
        expect(admitted.lifetime.isCurrent()).toBe(false);
        expect(hook.getCurrent()).toBeNull();
        await act(async () => { storage.setState((state) => ({ sessions: {
            ...state.sessions,
            'session-a': { ...state.sessions['session-a']!, access: undefined },
        } })); });
        expect(hook.getCurrent()).toBeNull();
    });

    it('stays bound to the exact requested Home across a two-Home shell switch', async () => {
        publishSession('srv_home-a', 'shared-session');
        const hook = await renderHook(
            ({ serverId }) => useSessionCallerHostedHtmlRuntime(serverId, 'shared-session'),
            { initialProps: { serverId: 'srv_home-a' } },
        );

        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()).toMatchObject({
            serverIdentityId: 'srv_home-a',
            accountId: 'account:srv_home-a',
            accountEncryptionMode: 'plain',
        });

        await act(async () => { publishSession('srv_home-b', 'shared-session'); });
        await hook.rerender({ serverId: 'srv_home-b' });
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()).toMatchObject({
            serverIdentityId: 'srv_home-b',
            accountId: 'account:srv_home-b',
            accountEncryptionMode: 'e2ee',
        });
    });

    it.each(['ios', 'android'])('admits caller-authored execution on %s through the same exact-Home runtime', async (platform) => {
        platformState.current = platform;
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()).toMatchObject({
            serverIdentityId: 'srv_home-a',
            accountId: 'account:srv_home-a',
            hostOrigin: 'https://app.happier.dev',
        });
    });

    it('retires native execution when the exact Account or Session is no longer current', async () => {
        platformState.current = 'android';
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());

        await act(async () => { storage.setState({ sessions: {} }); });
        expect(hook.getCurrent()).toBeNull();

        await act(async () => {
            credentials.delete('srv_home-a');
            for (const listener of credentialListeners) listener({
                kind: 'credentials_removed', serverId: 'srv_home-a', serverUrl: 'https://srv_home-a.example.test',
            });
            publishSession();
        });
        expect(hook.getCurrent()).toBeNull();
    });

    it('keeps the same runtime authority across unrelated local preference changes', async () => {
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const before = hook.getCurrent()!;
        await act(async () => { storage.setState((state) => ({ localSettings: {
            ...state.localSettings, debugMode: !state.localSettings.debugMode,
        } })); });
        expect(hook.getCurrent()).toBe(before);
    });

    it('keeps an admitted controller usable across projection replacement and refuses new calls after retirement', async () => {
        const hook = await renderHook(({ runtime }) => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a', runtime), {
            initialProps: { runtime: pluginRuntime },
        });
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const controller = hook.getCurrent()!.createRequestController(() => {});
        const readMissing = () => controller.handleRequest({ requestId: 'missing', method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'missing' } } });
        // The declaration resolver is real. Its specific refusal proves that
        // the request reached admission rather than an obsolete snapshot fence.
        await expect(readMissing()).rejects.toThrow('plugin_resource_not_found');
        await hook.rerender({ runtime: { ...pluginRuntime,
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 2 } } });
        await expect(readMissing()).rejects.toThrow('plugin_resource_not_found');
        await hook.rerender({ runtime: { ...pluginRuntime, phase: 'unavailable', interactionEnabled: false } });
        await expect(controller.handleRequest({ requestId: 'retired', method: 'executeAction',
            payload: { action: { pluginId: 'acme.preview', localId: 'open' } },
        })).rejects.toThrow('caller_surface_retired');
        controller.dispose();
    });

    it('withdraws prior guest authority while the canonical Account mode is revalidated', async () => {
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', undefined));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const prior = hook.getCurrent()!;
        // A real HTTP read stays pending; no second mode source or fabricated default.
        vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
        await act(async () => { invalidateAccountEncryptionModeCache(); });
        expect(hook.getCurrent()).toBeNull();
        expect(prior.lifetime.isCurrent()).toBe(false);
    });

    it.each(['ios', 'android'])('does not advertise caller HTML on %s without the native registrar', async (platform) => {
        platformState.current = platform;
        frameAvailability.current = false;
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        expect(hook.getCurrent()).toBeNull();
    });
});
