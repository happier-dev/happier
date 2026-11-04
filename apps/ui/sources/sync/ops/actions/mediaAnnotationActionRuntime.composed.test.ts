import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { Image } from 'react-native';
import { type ImageMarksOperationV1, type ComposerSnapshotV1, type ComposerRefV1 } from '@happier-dev/protocol';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import { renderHook, standardCleanup, act, flushHookEffects } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { createBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/annotationAdapter';
import { applyBrowserAnnotationOperations, startBrowserAnnotationDraft } from '@/sync/domains/browser/context/annotationDraft';
import { registerBrowserContextAnnotationAdapter, readRegisteredBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/runtimeAnnotationRegistry';
import { createBrowserContextState } from '@/sync/domains/browser/context/state';
import type { BrowserControlViewState } from '@/sync/domains/browser/control/state';
import type { SkiaMockBoundary } from '@/dev/testkit/mocks/skia';
import { installQuickBase64Boundary } from '@/dev/testkit/mocks/quickBase64';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

const nativeSkia = vi.hoisted(() => ({ boundary: null as SkiaMockBoundary | null }));
vi.mock('@shopify/react-native-skia', async () => {
    const mock = (await import('@/dev/testkit/mocks/skia')).createSkiaModuleMock();
    nativeSkia.boundary = mock.boundary;
    return mock.module;
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ localUri: 'file:///inter.ttf' }) } }));
vi.mock('react-native', async () => {
    const runtime = await import('@/dev/testkit/mocks/reactNative');
    const overrides = { Image: { getSize: (_uri: string, success: (width: number, height: number) => void) => { success(40, 30); } } };
    return process.env.HAPPIER_UI_TEST_NATIVE_PLATFORM
        ? runtime.createReactNativeNativeMock({ platformOS: process.env.HAPPIER_UI_TEST_NATIVE_PLATFORM === 'ios' ? 'ios' : 'android' }, overrides)
        : runtime.createReactNativeWebMock(overrides);
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
// Native locale activation uses Metro's synchronous require; bridge the real English payloads.
const nativeLocaleModules = process.env.HAPPIER_UI_TEST_NATIVE_PLATFORM ? await Promise.all([
    loadVitestModuleForNodeRequire(new URL('../../../text/translations/en.ts', import.meta.url), () => import('@/text/translations/en')),
    loadVitestModuleForNodeRequire(new URL('../../../text/bundledPluginTranslations/en.generated.ts', import.meta.url), () => import('@/text/bundledPluginTranslations/en.generated')),
]) : [];
afterAll(() => { for (const module of nativeLocaleModules) module.dispose(); });
await loadSyncSingletonForTests();
const { createBrowserRuntimeActionExecutor } = await import('@/sync/domains/browser/actions/runtimeActionExecutor');
const { executeMediaAnnotationAction } = await import('./mediaAnnotationActionRuntime');
const { registerComposerPresentationTarget, registerSessionComposerPresentationTarget, useStableComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createImageAnnotator } = await import('@/components/ui/media/annotation/annotatorStore');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { useAttachmentDraftManager } = await import('@/components/sessions/attachments/useAttachmentDraftManager');
const { syncSettings } = await import('@/sync/engine/settings/syncSettings');
const { sync } = await import('@/sync/sync');

const ref = { kind: 'newSession', instanceId: 'annotation-composer' } as const;
const original = { kind: 'memory' as const, bytes: new Uint8Array([1, 2, 3]), name: 'source.png', mimeType: 'image/png' };
const operation: ImageMarksOperationV1 = { kind: 'mark.add', mark: { id: 'arrow-a', kind: 'arrow', from: { x: 1, y: 2 }, to: { x: 20, y: 25 }, color: 'red', size: 'm' } };
let scope: { serverId: string; accountId: string };
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let canvas: ReturnType<typeof installImageAnnotationCanvasBoundary>;

beforeEach(async () => {
    if (process.env.HAPPIER_UI_TEST_NATIVE_PLATFORM) installQuickBase64Boundary();
    if (nativeSkia.boundary) nativeSkia.boundary.encodes = 0;
    await home.reset();
    const serverUrl = 'https://annotation-actions.test';
    const serverId = await home.addHome({ name: 'Annotation', serverUrl, accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a', request: home.request });
    scope = { serverId, accountId: 'account-a' };
    getStorage().setState({ profileScope: scope });
    // A mounted signed-in composer has its Account settings loaded. Cold restoration
    // returns before this owner settles when the Socket boundary remains disconnected.
    await syncSettings({ credentials: connection.credentials, encryption: null, settingsScope: scope,
        pendingSettings: {}, clearPendingSettings: () => {} });
    await sync.resumeSync('manual');
    await sync.awaitBootstrapForegroundAcquisition();
    // Settings starts both owners after foreground readiness. Settle their legacy
    // Settings/currentness reads before measuring the unrelated annotation Action.
    await Promise.all([
        sync.applyAuthoringMemoryDelta({}, { expectedSettingsScope: scope }),
        sync.refreshProjectAccountRows(),
    ]);
    await flushHookEffects();
    expect(getStorage().getState().settingsScope).toEqual(scope);
    canvas = installImageAnnotationCanvasBoundary();
});
afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = undefined; vi.unstubAllGlobals(); });

async function mount(composerRef: ComposerRefV1 = ref) {
    let editable = true;
    const initialDrafts: readonly AttachmentDraft[] = [{ id: 'picture-a', source: original, status: 'uploaded', uploadedPath: '/previous.png', sha256: 'previous' }];
    const snapshot: ComposerSnapshotV1 = { revision: 1, ref: composerRef, text: '', references: [], attachments: [], layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { editable, submittable: true, submitting: false, focused: true, running: false } };
    const hook = await renderHook(() => {
        const manager = useAttachmentDraftManager({ enabled: true, maxFileBytes: original.bytes.byteLength, initialDrafts });
        const target = useStableComposerPresentationTarget(composerRef, { readRevision: () => 1, replace: () => 1, readScope: () => scope,
            readSnapshot: () => ({ ...snapshot, state: { ...snapshot.state, editable } }), readPickedAttachments: () => manager });
        React.useEffect(() => composerRef.kind === 'session'
            ? registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: composerRef.sessionId }, target)
            : registerComposerPresentationTarget(composerRef, target), [target, composerRef]);
        return manager;
    });
    const manager = hook.getCurrent();
    return { draft: () => manager.getDraftsSnapshot()[0]!, replacements: manager.getDraftRevisionSnapshot,
        setEditable: (value: boolean) => { editable = value; } };
}
const input = () => ({ scope, target: { kind: 'composerAttachment' as const, ref, attachmentId: 'picture-a' } });
const context = () => ({ surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId });

describe('annotation Actions through the real composer occurrence', () => {
    it('routes an Account-scoped still-capture read to its referenced window', async () => {
        const result = { document: { v: 1, image: { width: 40, height: 30, scale: 2 }, marks: [] },
            image: { width: 40, height: 30, scale: 2 }, hasBlur: false };
        const invoke = vi.fn(async () => result);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const request = { scope, target: { kind: 'capture' as const, captureRef: 'still-a' } };
        expect(await executeMediaAnnotationAction({ actionId: 'media.annotation.read', input: request, context: context() }))
            .toEqual(result);
        expect(invoke).toHaveBeenCalledWith('desktop_capture_annotation_request', {
            captureRef: 'still-a', request: { actionId: 'media.annotation.read', input: request },
        });
        const before = invoke.mock.calls.length;
        expect(await executeMediaAnnotationAction({ actionId: 'media.annotation.read',
            input: { ...request, scope: { ...scope, accountId: 'foreign' } }, context: context() }))
            .toEqual({ status: 'unavailable', reason: 'annotation.targetUnavailable' });
        expect(invoke.mock.calls).toHaveLength(before);
    });
    it('reads the registered browser draft document without capture, flatten, upload or server work', async () => {
        const capabilities = buildBrowserAdapterCapabilities({ adapterKind: 'localPreview',
            supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'] });
        const view: BrowserControlViewState = {
            browserSessionId: 'browser_read_1', viewId: 'view_read_1',
            target: { kind: 'localServicePreview', targetId: 'preview_read_1', sessionId: 'session_1', machineId: 'machine_1' },
            platform: 'web', adapterKind: 'localPreview', engineKind: 'webIframe', adapterCapabilities: capabilities,
            currentUrl: 'https://annotation-actions.test/page', currentUrlExpiresAt: null, pendingUrl: null,
            title: 'Preview', faviconUrl: null, loadingState: 'ready', loadingProgress: 1,
            navigationGeneration: 1, canGoBack: false, canGoForward: false,
            securityOrigin: 'https://annotation-actions.test', lastError: null, openerViewId: null,
            adapterRefreshStatus: 'idle', adapterRefreshError: null,
        };
        let state = startBrowserAnnotationDraft(createBrowserContextState(), {
            browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: 1, nowMs: 1,
            source: { uri: 'data:image/png;base64,AQID', width: 40, height: 30, scale: 2 },
            capture: { bytes: original.bytes, mimeType: 'image/png', width: 40, height: 30, sizeBytes: original.bytes.length },
        });
        state = applyBrowserAnnotationOperations(state, { viewId: view.viewId, operations: [{ kind: 'mark.add', mark: {
            id: 'blur_read', kind: 'blur', rect: { x: 0, y: 0, width: 10, height: 10 }, size: 'm',
        } }] });
        let publications = 0;
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view, browserContextEnabled: true,
                contextCapabilities: { enabled: true, available: true, supportedContextKinds: ['browserAnnotation'],
                    supportedAdapterKinds: ['localPreview'], screenshot: { supported: true, requiresAttachmentUploads: true },
                    text: { maxSelectionChars: 2048, maxSummaryChars: 8192 }, disabledReasons: [], policyDeniedReasons: [] } }),
            onStateChange: next => { state = next; publications += 1; },
        });
        const registration = { scope, browserSessionId: view.browserSessionId, viewId: view.viewId, adapter };
        const unregister = registerBrowserContextAnnotationAdapter(registration);
        const requests = home.requests.length;
        const initial = state;
        try {
            const executor = createDefaultActionExecutor();
            const request = { scope, target: { kind: 'browserView' as const, browserSessionId: view.browserSessionId, viewId: view.viewId } };
            expect(await executor.execute('media.annotation.read', request, context())).toMatchObject({ ok: true, result: {
                document: state.annotationDraftByViewId[view.viewId]?.document,
                image: { width: 40, height: 30, scale: 2 }, hasBlur: true,
            } });
            expect(await executor.execute('media.annotation.read', { ...request, target: { ...request.target, viewId: 'missing_view' } }, context()))
                .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
            const foreignScope = { ...scope, accountId: 'foreign_account' };
            expect(await executeMediaAnnotationAction({ actionId: 'media.annotation.read',
                input: { ...request, scope: foreignScope }, context: { ...context(), runtimeAccountId: foreignScope.accountId } }))
                .toEqual({ status: 'unavailable', reason: 'annotation.targetUnavailable' });
            expect(state).toBe(initial);
            expect(canvas.encodeCount()).toBe(0);
            expect(home.requests.slice(requests)).toEqual([]);

            expect(await executor.execute('media.annotation.apply', { ...request, operations: [operation] }, context()))
                .toEqual({ ok: true, result: { status: 'replaced' } });
            expect(state.annotationDraftByViewId[view.viewId]?.document.marks).toEqual([
                ...initial.annotationDraftByViewId[view.viewId]!.document.marks, operation.mark,
            ]);
            expect(publications).toBe(1);
            expect(canvas.encodeCount()).toBe(0);
            expect(home.requests.slice(requests)).toEqual([]);
            const applied = state;
            expect(await executor.execute('media.annotation.apply', { ...request, scope: foreignScope, reset: true }, context()))
                .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
            expect(state).toBe(applied);
            expect(await executor.execute('media.annotation.apply', { ...request, reset: true }, context()))
                .toEqual({ ok: true, result: { status: 'reverted' } });
            expect(state.annotationDraftByViewId[view.viewId]?.document.marks).toEqual([]);
            expect(state.annotationDraftByViewId[view.viewId]?.source).toBe(initial.annotationDraftByViewId[view.viewId]!.source);
            expect(publications).toBe(2);
            expect(canvas.encodeCount()).toBe(0);
            expect(home.requests.slice(requests)).toEqual([]);
            const reset = state;

            const browser = createBrowserRuntimeActionExecutor({ resolveAnnotation: readRegisteredBrowserContextAnnotationAdapter });
            const browserInput = { browserSessionId: view.browserSessionId, viewId: view.viewId,
                navigationGeneration: view.navigationGeneration, comment: 'Use this spacing' };
            expect(await browser({ actionId: 'browser.context.annotation.setDraftComment', input: browserInput,
                context: { ...context(), runtimeAccountId: foreignScope.accountId } }))
                .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
            expect(state).toBe(reset);
            expect(await browser({ actionId: 'browser.context.annotation.setDraftComment', input: browserInput, context: context() }))
                .toMatchObject({ status: 'draftUpdated' });
            expect(state.annotationDraftByViewId[view.viewId]?.comment).toBe('Use this spacing');
        } finally { unregister(); }
    });

    it('refuses removed attachments, foreign Accounts and read-only mutation without flattening or replacement', async () => {
        const mounted = await mount();
        const executor = createDefaultActionExecutor();
        for (const request of [{ ...input(), scope: { ...scope, accountId: 'foreign' }, operations: [operation] },
            { ...input(), target: { ...input().target, attachmentId: 'removed' }, operations: [operation] }]) {
            expect(await executor.execute('media.annotation.apply', request, context())).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
        }
        mounted.setEditable(false);
        expect(await executor.execute('media.annotation.apply', { ...input(), operations: [operation] }, context())).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
        expect(canvas.encodeCount()).toBe(0);
        expect(mounted.replacements()).toBe(0);
    });

    it('preserves the original and the typed platform reason when flatten cannot finish', async () => {
        const mounted = await mount();
        const executor = createDefaultActionExecutor();
        for (const [options, reason] of [
            [{ decodeFailed: true }, 'flatten.decodeFailed'],
            [{ canvasUnavailable: true }, 'flatten.canvasUnavailable'],
        ] as const) {
            canvas = installImageAnnotationCanvasBoundary({ width: 40, height: 30, pixels: new Uint8ClampedArray(40 * 30 * 4), ...options });
            expect(await executor.execute('media.annotation.apply', { ...input(), operations: [operation] }, context())).toMatchObject({ ok: true, result: { status: 'unavailable', reason } });
            expect(canvas.encodeCount()).toBe(0);
            expect(mounted.draft().source).toBe(original);
            expect(mounted.replacements()).toBe(0);
        }
    });

    it('reaches a qualified Session composer through its existing mounted registration', async () => {
        const sessionRef = { kind: 'session', sessionId: 'annotation-session' } as const;
        const mounted = await mount(sessionRef);
        const executor = createDefaultActionExecutor();
        await act(async () => {
            expect(await executor.execute('media.annotation.apply', { scope, target: { kind: 'composerAttachment', ref: sessionRef, attachmentId: 'picture-a' }, operations: [operation] }, context()))
                .toMatchObject({ ok: true, result: { status: 'replaced' } });
        });
        expect(mounted.draft().edit?.document.marks).toEqual([operation.mark]);
        expect(mounted.replacements()).toBe(1);
    });


});
