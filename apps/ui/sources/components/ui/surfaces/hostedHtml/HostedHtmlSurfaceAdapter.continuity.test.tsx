import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HostedHtmlSurfaceAdapter, type CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';

const observations = vi.hoisted(() => ({ frames: [] as Record<string, unknown>[] }));
// Physical browser frame only; the real caller adapter and shared bridge remain exercised.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: Record<string, unknown> }>) => {
        observations.frames.push(props.engine);
        return React.createElement('BrowserViewFrame');
    },
}));

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); observations.frames = []; });

it('keeps a live caller frame connected across an equivalent parent render', async () => {
    const runtime: CallerHostedHtmlRuntime = {
        serverIdentityId: 'home-a', accountId: 'account-a', hostOrigin: 'https://app.example.com',
        admittedHostMethods: ['context', 'watchContext'],
        isApproved: () => true, approve: () => undefined, revoke: () => undefined,
        createRequestController: () => ({ handleRequest: async () => null, dispose: () => undefined }),
        lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
    };
    const source = artifactHtmlBundleFromBodyV1('<main>same document</main>');
    const requestedCapabilities = { hostMethods: ['context', 'watchContext'] };
    const render = () => <HostedHtmlSurfaceAdapter
        sessionId="session-a" title="same title" recordRevision="revision-a"
        approvalSubject="same-source" source={source} requestedCapabilities={requestedCapabilities}
        surfaceContext={{ kind: 'widget', sessionId: 'session-a', itemId: 'item-a', recordRevision: 'revision-a' }}
        runtime={runtime} testID="probe-html"
    />;
    const screen = await renderScreen(render());
    const firstFrame = observations.frames.at(-1)!;
    const posted: unknown[] = [];
    const transport = firstFrame.webMessageBridge as Readonly<{
        attachHostMessages: (send: (message: unknown) => void) => (() => void);
    }>;
    const detach = transport.attachHostMessages((message) => posted.push(message));
    await screen.update(render());
    expect(observations.frames.at(-1)!.html).toBe(firstFrame.html);
    detach();
    expect(posted).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ kind: 'disconnected' }) }),
    ]));
});

it('bootstraps caller HTML with the canonical host environment before reveal', async () => {
    const runtime: CallerHostedHtmlRuntime = {
        serverIdentityId: 'home-a', accountId: 'account-a', hostOrigin: 'https://app.example.com',
        admittedHostMethods: ['context', 'watchContext'],
        isApproved: () => true, approve: () => undefined, revoke: () => undefined,
        createRequestController: () => ({ handleRequest: async () => null, dispose: () => undefined }),
        lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
    };
    await renderScreen(<HostedHtmlSurfaceAdapter
        sessionId="session-a" title="environment" recordRevision="revision-a"
        approvalSubject="environment-source" source={artifactHtmlBundleFromBodyV1('<main>environment</main>')}
        requestedCapabilities={{ hostMethods: ['context', 'watchContext'] }}
        surfaceContext={{ kind: 'widget', sessionId: 'session-a', itemId: 'item-a', recordRevision: 'revision-a' }}
        runtime={runtime} testID="environment-html"
    />);
    const frame = observations.frames.at(-1)!;
    const encoded = String(frame.html).match(/Object\.freeze\((\{.*?\})\),writable:false/)?.[1];
    if (!encoded) throw new Error('expected_inline_frame_bootstrap');
    const { identity } = JSON.parse(encoded) as { identity: { instanceId: string; mountNonce: string } };
    const transport = frame.webMessageBridge as Readonly<{
        attachHostMessages: (send: (message: unknown) => void) => (() => void);
        onMessage: (event: MessageEvent, receipt: { consumeTransientActivation(): boolean }) => unknown;
    }>;
    const posted: Array<{ payload?: { kind?: string; surface?: Record<string, unknown> } }> = [];
    const detach = transport.attachHostMessages((message) => posted.push(message as never));
    const receipt = { consumeTransientActivation: () => false };
    const send = async (sequence: number, kind: string, payload: unknown) => await transport.onMessage(
        { data: { version: 1, identity, sequence, kind, payload }, origin: 'null' } as MessageEvent,
        receipt,
    );
    await send(1, 'ready', { ready: true });
    // The negotiation reply is the frame's first Host API context, delivered before reveal.
    const negotiated = await send(2, 'hostApi', { wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1.0.0' }) as
        { payload?: { kind?: string; surface?: Record<string, unknown> } };
    expect(negotiated.payload?.kind).toBe('negotiated');
    const surface = negotiated.payload!.surface!;
    // The same environment facts every installed surface receives, from the one producer.
    expect(surface).toMatchObject({
        direction: expect.stringMatching(/^(ltr|rtl)$/),
        colorScheme: expect.stringMatching(/^(light|dark)$/),
        contrast: expect.stringMatching(/^(normal|high)$/),
        textScale: expect.any(Number),
        reducedMotion: expect.any(Boolean),
        locale: expect.any(String),
        safeAreaInsets: expect.objectContaining({ top: expect.any(Number) }),
        theme: expect.any(Object),
    });
    expect(surface).toMatchObject({ context: { kind: 'widget', itemId: 'item-a' } });
    detach();
});
