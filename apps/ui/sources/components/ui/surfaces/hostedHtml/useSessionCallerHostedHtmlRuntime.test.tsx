import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionAccessFixture, createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginHostedWebBridgeEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_BROWSER_PROJECTION } from '@/sync/domains/plugins/browser/targets';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';

const platformState = vi.hoisted(() => ({ current: 'web' }));
const frameAvailability = vi.hoisted(() => ({ current: true }));
const credentials = vi.hoisted(() => new Map<string, string>());
const credentialListeners = vi.hoisted(() => new Set<(event: HomeCredentialMutationEvent) => void>());
const frames = vi.hoisted(() => [] as Record<string, unknown>[]);

// The physical browser frame is the platform boundary; keep the runtime,
// adapter, shared frame host and canonical Host API bridge real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: Record<string, unknown> }>) => {
        frames.push(props.engine);
        return React.createElement('BrowserViewFrame', { testID: 'physical-caller-frame' });
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
import { prepareCallerHostedHtmlSurface } from './prepareCallerHostedHtmlSurface';
import { HostedHtmlSurfaceAdapter } from './HostedHtmlSurfaceAdapter';

const pluginRuntime: SessionPluginRuntimeState = {
    phase: 'current', interactionEnabled: true, machineId: 'machine-a', serverId: 'srv_home-a',
    platform: 'web', pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1 }, pluginBrowserProjection: null,
};

const source = artifactHtmlBundleFromBodyV1('<main>Same document</main>');
const contextCapabilities = { hostMethods: ['context', 'watchContext'] };

function CallerSurface(props: Readonly<{ runtime: SessionPluginRuntimeState; value: string; requestedCapabilities?: unknown }>) {
    const runtime = useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a', props.runtime);
    return runtime ? <HostedHtmlSurfaceAdapter
        sessionId="session-a" title="Caller" recordRevision="revision-a" approvalSubject="item-a"
        source={source} requestedCapabilities={props.requestedCapabilities ?? contextCapabilities}
        surfaceContext={{ value: props.value }} runtime={runtime} testID="caller-surface"
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

function prepare(requestedCapabilities: unknown, overrides: Record<string, unknown> = {}) {
    const prepared = prepareCallerHostedHtmlSurface({
        serverIdentityId: 'srv_home-a', accountId: 'account:srv_home-a', approvalSubject: 'item-a',
        source: artifactHtmlBundleFromBodyV1('<main>Same document</main>'), requestedCapabilities,
        admittedHostMethods: ['context', 'watchContext', 'readResource', 'watchResource', 'executeAction', 'notify'],
        frameIdentity: { instanceId: 'frame-a', mountNonce: 'nonce-a' }, hostOrigin: 'https://app.happier.dev',
        ...overrides,
    });
    if (prepared.kind !== 'admitted') throw new Error(prepared.code);
    return prepared;
}

function publishSession(serverId = 'srv_home-a', sessionId = 'session-a') {
    storage.setState({ sessions: {
        [sessionId]: createSessionFixture({ id: sessionId, serverId }),
    } });
}

afterEach(() => { standardCleanup(); credentials.clear(); });

describe('useSessionCallerHostedHtmlRuntime', () => {
    beforeEach(async () => {
        platformState.current = 'web';
        frameAvailability.current = true;
        frames.length = 0;
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

    it('keeps the physical mount across unrelated browser projection updates but retires it on credential loss', async () => {
        const screen = await renderScreen(<CallerSurface runtime={pluginRuntime} value="before" />);
        await vi.waitFor(() => expect(screen.findByTestId('caller-surface-approval')).not.toBeNull());
        await screen.pressByTestIdAsync('caller-surface-approval-action');
        const before = readFrame(frames.at(-1)!);
        const physicalFrame = screen.findByTestId('physical-caller-frame');
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
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'hostApi', payload: expect.objectContaining({
                kind: 'subscription', subscriptionId: 'live-context',
                event: expect.objectContaining({ surface: expect.objectContaining({ context: { value: 'after' } }) }),
            }),
        }));
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

    it('mounts a reduced request without another review, then requires review when authority grows', async () => {
        const screen = await renderScreen(<CallerSurface runtime={pluginRuntime} value="same" />);
        await vi.waitFor(() => expect(screen.findByTestId('caller-surface-approval')).not.toBeNull());
        await screen.pressByTestIdAsync('caller-surface-approval-action');
        const original = readFrame(frames.at(-1)!);
        await screen.update(<CallerSurface runtime={pluginRuntime} value="same" requestedCapabilities={{ hostMethods: ['context'] }} />);
        expect(screen.findByTestId('caller-surface-approval')).toBeNull();
        expect(screen.findByTestId('physical-caller-frame')).not.toBeNull();
        expect(readFrame(frames.at(-1)!).identity).not.toEqual(original.identity);
        await screen.update(<CallerSurface runtime={pluginRuntime} value="same" requestedCapabilities={{ hostMethods: ['context', 'notify'] }} />);
        expect(screen.findByTestId('caller-surface-approval')).not.toBeNull();
        expect(screen.findByTestId('physical-caller-frame')).toBeNull();
    });

    it('reuses approval for a narrower request only within the same executable and authority, and revokes that approval', async () => {
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const full = prepare({ hostMethods: ['context', 'watchContext'],
            resources: [{ pluginId: 'acme.review', localId: 'status' }],
            actions: [{ pluginId: 'acme.review', localId: 'summarize' }],
            networkOrigins: ['https://status.example.test'] });
        const smaller = prepare({ hostMethods: ['context'], networkOrigins: ['https://status.example.test'] });
        const initial = hook.getCurrent()!;
        await act(async () => { initial.approve(full.approval, full.approvalKey, full.capabilityManifest.requested); });
        const approved = hook.getCurrent()!;
        expect(approved.lifetime).toBe(initial.lifetime);
        expect(approved.isApproved(smaller.approval, smaller.approvalKey, smaller.capabilityManifest.requested)).toBe(true);
        for (const changed of [
            prepare({ ...full.capabilityManifest.requested, hostMethods: ['context', 'watchContext', 'notify'] }),
            prepare({ ...full.capabilityManifest.requested, resources: [{ pluginId: 'acme.review', localId: 'other' }] }),
            prepare({ ...full.capabilityManifest.requested, actions: [{ pluginId: 'acme.review', localId: 'other' }] }),
            prepare({ ...full.capabilityManifest.requested, networkOrigins: ['https://other.example.test'] }),
            prepare(full.capabilityManifest.requested, { approvalSubject: 'item-b' }),
            prepare(full.capabilityManifest.requested, { accountId: 'account-b' }),
            prepare(full.capabilityManifest.requested, { serverIdentityId: 'srv_home-b' }),
            prepare(full.capabilityManifest.requested, { source: artifactHtmlBundleFromBodyV1('<main>Changed</main>') }),
        ]) expect(approved.isApproved(changed.approval, changed.approvalKey, changed.capabilityManifest.requested)).toBe(false);
        await act(async () => { approved.revoke(smaller.approval, smaller.approvalKey); });
        expect(hook.getCurrent()!.isApproved(full.approval, full.approvalKey, full.capabilityManifest.requested)).toBe(false);
        expect(hook.getCurrent()!.isApproved(smaller.approval, smaller.approvalKey, smaller.capabilityManifest.requested)).toBe(false);
        expect(hook.getCurrent()!.lifetime).toBe(initial.lifetime);

        // Separate consents cannot be combined to manufacture a broader one.
        const context = prepare({ hostMethods: ['context'] });
        const watch = prepare({ hostMethods: ['watchContext'] });
        for (const request of [context, watch]) {
            await act(async () => { hook.getCurrent()!.approve(request.approval, request.approvalKey, request.capabilityManifest.requested); });
        }
        const combined = prepare({ hostMethods: ['context', 'watchContext'] });
        expect(hook.getCurrent()!.isApproved(combined.approval, combined.approvalKey, combined.capabilityManifest.requested)).toBe(false);
    });

    it('retains legacy boolean approvals only for their exact capability key', async () => {
        const full = prepare({ hostMethods: ['context', 'watchContext'] });
        const smaller = prepare({ hostMethods: ['context'] });
        storage.setState((state) => ({ localSettings: {
            ...state.localSettings,
            uiSurfaceExecutableApprovalsV1: { [full.approvalKey]: true },
        } }));
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const runtime = hook.getCurrent()!;
        expect(runtime.isApproved(full.approval, full.approvalKey, full.capabilityManifest.requested)).toBe(true);
        expect(runtime.isApproved(smaller.approval, smaller.approvalKey, smaller.capabilityManifest.requested)).toBe(false);
        await act(async () => { runtime.revoke(full.approval, full.approvalKey); });
        expect(hook.getCurrent()!.isApproved(full.approval, full.approvalKey, full.capabilityManifest.requested)).toBe(false);
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
        });

        await act(async () => { publishSession('srv_home-b', 'shared-session'); });
        await hook.rerender({ serverId: 'srv_home-b' });
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()).toMatchObject({
            serverIdentityId: 'srv_home-b',
            accountId: 'account:srv_home-b',
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

    it('keeps one physical mount lifetime and request owner while another item\'s approval changes', async () => {
        // The real local-settings owner holds approvals; approving item B and
        // revoking it must not hand item A a new mount lifetime or controller.
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const before = hook.getCurrent()!;
        const prepared = prepare({ hostMethods: ['context'] }, { approvalSubject: 'item-b' });
        const { approval, approvalKey } = prepared;
        expect(before.isApproved(approval, approvalKey, prepared.capabilityManifest.requested)).toBe(false);

        await act(async () => { before.approve(approval, approvalKey, prepared.capabilityManifest.requested); });
        const approved = hook.getCurrent()!;
        expect(approved.isApproved(approval, approvalKey, prepared.capabilityManifest.requested)).toBe(true);
        expect(approved.lifetime).toBe(before.lifetime);
        expect(approved.createRequestController).toBe(before.createRequestController);

        await act(async () => { approved.revoke(approval, approvalKey); });
        const revoked = hook.getCurrent()!;
        expect(revoked.isApproved(approval, approvalKey, prepared.capabilityManifest.requested)).toBe(false);
        expect(revoked.lifetime).toBe(before.lifetime);
    });

    it.each(['ios', 'android'])('does not advertise caller HTML on %s without the native registrar', async (platform) => {
        platformState.current = platform;
        frameAvailability.current = false;
        const hook = await renderHook(() => useSessionCallerHostedHtmlRuntime('srv_home-a', 'session-a'));
        expect(hook.getCurrent()).toBeNull();
    });
});
