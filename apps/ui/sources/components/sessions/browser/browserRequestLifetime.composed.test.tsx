import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { BrowserAnnotationCaptureRequest } from '@/sync/domains/browser/context/types';

installSessionFilesViewBoundaries({ platformOS: 'web' });
vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1400, height: 900, scale: 1, fontScale: 1 }),
}));
await prepareSessionFilesViewTestkit();
const { useBrowserDaemonControlTransport } = await import('@/sync/domains/browser/control/useBrowserDaemonControlTransport');
const { useSessionBrowserContextProductModel } = await import('./useSessionBrowserContextProductModel');
const { useSessionBrowserContextRuntime, SessionBrowserContextRuntimeProvider } = await import('./sessionBrowserContextRuntime');
const { submitComposerSnapshot } = await import('@/components/sessions/composer/composerSubmissionCoordinator');
const { BrowserActionResultReference } = await import('@/components/sessions/transcript/references/BrowserActionResultReference');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { vi.useRealTimers(); standardCleanup(); await fixture?.dispose(); });

const command = { kind: 'reload', commandId: 'reload', browserSessionId: 'browser_1', viewId: 'view_1' } as const;
const capture: BrowserAnnotationCaptureRequest = { browserSessionId: 'browser_1', viewId: 'view_1',
    navigationGeneration: 0, capturedAtMs: 1, adapterKind: 'chromiumSidecar',
    browserTarget: { kind: 'externalUrl', targetId: 'target_1', url: 'https://example.test/' } };

async function setup(reply: Promise<void>) {
    fixture = await createSessionFilesViewFixture({ rpc: async request => {
        if (request.method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH) {
            await reply;
            return { protocolVersion: 1, result: { v: 1, commandId: command.commandId, status: 'dispatched',
                adapterKind: 'chromiumSidecar', events: [] } };
        }
        if (request.method === RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH) {
            await reply;
            return { protocolVersion: 1, result: { ok: false, errorCode: 'invalid_parameters', error: 'Capture unavailable' } };
        }
        if (request.method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST) {
            await reply;
            return { protocolVersion: 1, views: [] };
        }
        if (request.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1) {
            await reply;
            return { success: true, available: true, capability: 'composer.mediaContent.v1' };
        }
        return undefined;
    } });
}

describe('Browser request lifetime through the mounted owner and real RPC', () => {
    it('retires a non-replying control command on target change, retries, and cancels on unmount', async () => {
        const reply = createDeferred<void>();
        await setup(reply.promise);
        const scope = { machineId: 'm1', serverId: fixture.home.id };
        const hook = await renderHook(useBrowserDaemonControlTransport, { initialProps: scope });
        vi.useFakeTimers();
        let settled = false;
        const pending = hook.getCurrent()!(command).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH)).toBe(true));
            await vi.advanceTimersByTimeAsync(120_000);
            expect(settled).toBe(false);
            await hook.rerender({ ...scope, machineId: '' });
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(await pending).toEqual({ ok: false, reason: 'request_failed' });
            expect(fixture.emissions.some(item => item.event === 'rpc-cancel')).toBe(true);
            await hook.rerender(scope);
            let secondSettled = false;
            const second = hook.getCurrent()!(command).finally(() => { secondSettled = true; });
            await vi.waitFor(() => expect(fixture.requests.filter(request => request.method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH)).toHaveLength(2));
            await hook.unmount();
            await vi.advanceTimersByTimeAsync(1);
            expect(secondSettled).toBe(true);
            expect(await second).toEqual({ ok: false, reason: 'request_failed' });
            reply.resolve();
            const remount = await renderHook(useBrowserDaemonControlTransport, { initialProps: scope });
            expect(await remount.getCurrent()!(command)).toMatchObject({ ok: true });
        } finally { reply.resolve(); await pending; }
    });

    it('retires an unanswered annotation capture on navigation and allows the next capture', async () => {
        const reply = createDeferred<void>();
        await setup(reply.promise);
        function Wrapper({ children }: React.PropsWithChildren) {
            const runtime = useSessionBrowserContextRuntime({ enabled: true });
            return <SessionBrowserContextRuntimeProvider runtime={runtime}>{children}</SessionBrowserContextRuntimeProvider>;
        }
        const hook = await renderHook(() => useSessionBrowserContextProductModel({ machineId: 'm1', serverId: fixture.home.id }), { wrapper: Wrapper });
        vi.useFakeTimers();
        let settled = false;
        const pending = hook.getCurrent()!.annotationCaptureProvider!.captureViewport!(capture);
        const observation = Promise.resolve(pending).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH)).toBe(true));
            await act(async () => hook.getCurrent()!.onStateChange({ ...hook.getCurrent()!.state,
                navigationGenerationByViewId: { view_1: 1 } }));
            await flushHookEffects();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(await observation).toMatchObject({ status: 'unavailable' });
            reply.resolve();
            await hook.getCurrent()!.annotationCaptureProvider!.captureViewport!({ ...capture, navigationGeneration: 1 });
            expect(fixture.requests.filter(request => request.method === RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH)).toHaveLength(2);
        } finally { reply.resolve(); await observation; }
    });

    it('cancels a staged-media submission probe with its composer scope and retains the draft', async () => {
        const reply = createDeferred<void>();
        await setup(reply.promise);
        const controller = new AbortController();
        const snapshot: import('@happier-dev/protocol/plugins/ui/composer').ComposerSnapshotV1 = {
            revision: 1, ref: { kind: 'session', sessionId: 's1' }, text: 'Look', references: [], layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
            attachments: [{ v: 1, instanceId: 'image_1', attachment: { pluginId: 'test.media', localId: 'image' },
                key: 'image', value: {}, presentation: { label: 'Image', typeLabel: 'Image' }, availability: { status: 'ready' },
                content: { kind: 'stagedMedia', handle: { v: 1, id: 'stage_1',
                    executionTarget: { machineId: 'm1', serverId: fixture.home.id }, owner: { pluginId: 'test.media', localId: 'image' },
                    mediaKind: 'image', mimeType: 'image/png', name: 'image.png', sizeBytes: 4, sha256: 'a'.repeat(64) } } }],
        };
        const admit = vi.fn(() => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        vi.useFakeTimers();
        let settled = false;
        const pending = submitComposerSnapshot({ snapshot, signal: controller.signal, clearAcceptedSnapshot,
            route: { kind: 'session', ref: snapshot.ref as { kind: 'session'; sessionId: string },
                readCurrentExecutionTarget: () => ({ machineId: 'm1', serverId: fixture.home.id }), admit } })
            .finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1)).toBe(true));
            controller.abort();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(await pending).toEqual({ status: 'unavailable' });
            expect(admit).not.toHaveBeenCalled();
            expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
            reply.resolve();
            expect(await submitComposerSnapshot({ snapshot, clearAcceptedSnapshot,
                route: { kind: 'session', ref: { kind: 'session', sessionId: 's1' },
                    readCurrentExecutionTarget: () => ({ machineId: 'm1', serverId: fixture.home.id }), admit } }))
                .toMatchObject({ status: 'accepted', cleared: true });
        } finally { reply.resolve(); await pending; }
    });

    it('retires an unanswered transcript Watch discovery when the row unmounts', async () => {
        const reply = createDeferred<void>();
        await setup(reply.promise);
        const screen = await renderScreen(<AppPaneProvider><BrowserActionResultReference sessionId="s1" serverId={fixture.home.id}
            tool={{ name: 'mcp__happier__action_execute', state: 'completed', input: { actionId: 'browser.view.open',
                input: { browserSessionId: 'browser_1', viewId: 'view_1',
                    target: { kind: 'externalUrl', targetId: 'target_1', url: 'https://example.test/' } } },
                result: null, createdAt: 1, startedAt: 1, completedAt: 2, description: null }} /></AppPaneProvider>);
        vi.useFakeTimers();
        let settled = false;
        const button = screen.tree.root.findAll(node => node.props.testID === 'transcript-browser-action-browser.view.open-watch'
            && typeof node.props.onPress === 'function')[0]!;
        let pending!: Promise<void>;
        act(() => { pending = Promise.resolve(button.props.onPress()).finally(() => { settled = true; }); });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST)).toBe(true));
            await act(async () => screen.tree.unmount());
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(fixture.emissions.some(item => item.event === 'rpc-cancel')).toBe(true);
        } finally { reply.resolve(); await pending; }
    });
});
