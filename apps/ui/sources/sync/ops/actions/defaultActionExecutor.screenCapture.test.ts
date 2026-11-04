import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { setFocusedSessionId, resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import type { NativeCaptureDisclosure, NativeCaptureResult, NativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';

const events = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
// The native event SDK is the process boundary; capture admission and settlement remain real.
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    getDesktopHostAvailability: async () => ({ windows: { kind: 'available' } }),
    listenDesktopHostEvent: async (name: string, handler: (payload: unknown) => void) => {
        const receive = (event: { payload: unknown }) => handler(event.payload);
        const handlers = events.get(name) ?? new Set(); handlers.add(receive); events.set(name, handlers);
        return () => { handlers.delete(receive); };
    },
}));
function emitNative(name: string, payload: unknown) {
    for (const handler of events.get(name) ?? []) handler({ payload });
}

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
const { storage } = await import('@/sync/domains/state/storage');
const { resetSessionDraftValueCachesForTests } = await import('@/dev/testkit/sessionDraftRepositoryTestkit');
const { writeExistingSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { readSessionAttachmentDrafts, clearSessionAttachmentDrafts, resolveSessionAttachmentDraftScope } = await import('@/components/sessions/attachments/sessionAttachmentDraftStore');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createNativeScreenCaptureAction } = await import('./screenCaptureActions');

describe('screen capture through the default executor and native adapter', () => {
    const captured: NativeCaptureResult = { captureRef: 'capture-one', kind: 'still', path: '/Pictures/Happier/capture-one.png',
        mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1,
        origin: null, source: null, windowTextRef: 'private-window-text' };
    const commands: string[] = [];
    let preparedMissing = false;
    let inUse = true;
    let settleFailed = false;
    let discardFailed = false;
    const emitted: unknown[] = [];
    let windowTextRefusal: 'blurred_capture' | 'capture_in_use' | null = null;
    let disclosure: NativeCaptureDisclosure | null = null;
    let cachedWindowText: NativeCaptureWindowText | null = null;
    let extractedWindowText: NativeCaptureWindowText;
    let openedTarget: unknown;
    let nativeWindowLabel: string | null = null;
    let target: Readonly<{ serverId: string; accountId: string; sessionId: string }>;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    beforeEach(async () => {
        await homes.reset();
        resetSessionDraftValueCachesForTests();
        const serverId = await homes.addHome({ name: 'Capture', serverUrl: 'https://capture-actions.test', accountId: 'alice', currentAccount: true });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://capture-actions.test', accountId: 'alice',
            request: createSessionReadBatchFetchBoundary(homes.request) });
        target = { serverId, accountId: 'alice', sessionId: 'capture-session' };
        storage.getState().activateProfileScope(target);
        await storage.getState().activateSettingsScope(target);
        storage.getState().activateSessionLocalStateScope(target);
        storage.setState(state => ({
            sessions: { ...state.sessions, [target.sessionId]: createSessionFixture({ id: target.sessionId, serverId: target.serverId }) },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [target.serverId]: {} },
        }));
        writeExistingSessionDraft({ scope: target, sessionId: target.sessionId, patch: { text: 'Existing words' } });
        commands.length = 0; preparedMissing = false; inUse = true; settleFailed = false; openedTarget = undefined; windowTextRefusal = null;
        discardFailed = false; events.clear(); emitted.length = 0; nativeWindowLabel = null;
        disclosure = { hasMarks: true, includeWindowText: false }; cachedWindowText = null;
        extractedWindowText = { status: 'unavailable', reason: 'no_window_context', source: null };
        // The desktop invoke is the OS/file boundary; Action, adapter and draft owners are real.
        const secureStorage = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { metadata: { currentWindow: { get label() { return nativeWindowLabel; } } },
            invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
            commands.push(command);
            if (command === 'desktop_capture_start') return { status: 'completed', operationRef: 1, result: captured };
            if (command === 'desktop_capture_read_state') return { status: 'idle' };
            if (command === 'desktop_capture_read_delivery_state') return { inUse, disclosure, windowText: cachedWindowText };
            if (command === 'desktop_capture_read_result') return captured;
            if (command === 'desktop_capture_discard') {
                if (discardFailed) throw 'file_io';
                emitNative('desktopCapture://state', { status: 'idle' });
                return;
            }
            if (command === 'desktop_window_emit_action_result') {
                nativeWindowLabel = 'main';
                emitted.push(args?.payload); emitNative('desktopWindow://action-result', args?.payload); return;
            }
            if (command === 'desktop_window_emit_action') {
                const payload = args?.payload as Record<string, unknown>;
                nativeWindowLabel = String(payload.targetWindowLabel);
                emitNative('desktopWindow://action', payload); return;
            }
            if (command === 'desktop_capture_window_text') {
                if (windowTextRefusal) throw windowTextRefusal;
                return extractedWindowText;
            }
            if (command === 'desktop_capture_read_prepared_png') {
                if (preparedMissing) throw 'prepared_missing';
                return [4, 5, 6];
            }
            if (command === 'desktop_capture_retain_prepared_png') {
                if (preparedMissing) throw 'prepared_missing';
                return { ...captured, captureRef: 'retained-capture' };
            }
            if (command === 'desktop_capture_read_source_png') return [4, 5, 6];
            if (command === 'desktop_capture_settle') {
                if (settleFailed) throw 'native_failure';
                return { status: 'idle' };
            }
            if (command === 'desktop_capture_open') {
                openedTarget = args?.targetSession;
                return { status: 'completed', operationRef: 1, result: captured };
            }
            throw new Error('Unexpected native command');
        } });
    });
    afterEach(async () => {
        clearSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target));
        resetSessionSurfaceVisibilityForTests();
        await connection?.dispose(); connection = undefined;
        events.clear(); vi.unstubAllGlobals(); await standardCleanup();
        (await import('@/desktop/capture/useNativeRecordingActive')).setScreenSharingPrivacyActive(false);
    });

    it('sets screen-sharing privacy on this client without invoking native capture or writing Account settings', async () => {
        // Change only the native-host boundary; keep the signed-in browser harness globals.
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        const executor = createDefaultActionExecutor();
        const settings = storage.getState().settings;
        expect(await executor.execute('screenCapture.privacy.set', { active: true }, { surface: 'ui', serverId: target.serverId }))
            .toMatchObject({ ok: true, result: { active: true } });
        const { readScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        expect(readScreenSharingPrivacyActive()).toBe(true);
        expect(await executor.execute('screenCapture.privacy.set', { active: false }, { surface: 'ui', serverId: target.serverId }))
            .toMatchObject({ ok: true, result: { active: false } });
        expect(readScreenSharingPrivacyActive()).toBe(false);
        expect(storage.getState().settings).toBe(settings);
        expect(commands).toEqual([]);
    });

    it('reaches native acquisition through default Action wiring without startup reads or target enumeration', async () => {
        const executor = createDefaultActionExecutor();
        expect(commands).toEqual([]);
        expect(await executor.execute('screenCapture.start', { mode: 'screenshot', target: { kind: 'frontmost' } },
            { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: true,
                result: { status: 'completed', result: { captureRef: captured.captureRef } } });
        expect(commands).toEqual(['desktop_capture_start']);
    });


    it('returns desktop_only off desktop without native acquisition', async () => {
        // Retain the browser storage boundary while removing only the desktop host.
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        expect(await createDefaultActionExecutor().execute('screenCapture.start', { mode: 'screenshot' },
            { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: 'desktop_only' });
        expect(commands).toEqual([]);
    });

    it.each(['blurred_capture', 'capture_in_use'] as const)('preserves native window-text disclosure refusal %s through the real Action executor', async reason => {
        windowTextRefusal = reason;
        expect(await createDefaultActionExecutor().execute('screenCapture.windowText.read', { captureRef: captured.captureRef },
            { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: reason });
        expect(commands).toEqual(['desktop_capture_window_text']);
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(0);
    });

    it('keeps prepared-missing typed and never falls back to original pixels', async () => {
        preparedMissing = true;
        expect(await createDefaultActionExecutor({ screenCaptureWindowPress: true }).execute('screenCapture.addToDraft', {
            captureRef: captured.captureRef, session: target,
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: 'prepared_missing' });
        expect(commands).toContain('desktop_capture_retain_prepared_png');
        expect(commands).not.toContain('desktop_capture_read_source_png');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(0);
    });

    it.each([true, false])('decides custody before a missing persisted disclosure (inUse=%s)', async active => {
        inUse = active;
        disclosure = null;
        expect(await createDefaultActionExecutor().execute('screenCapture.addToDraft', {
            captureRef: captured.captureRef, session: target,
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false,
            errorCode: active ? 'capture_in_use' : 'capture_not_prepared' });
        expect(commands).not.toContain('desktop_capture_read_prepared_png');
        expect(commands).not.toContain('desktop_capture_retain_prepared_png');
        expect(commands).not.toContain('desktop_capture_read_source_png');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(0);
    });

    it.each(['screenCapture.send', 'screenCapture.addToDraft'] as const)('refuses a raw Capture bridge %s that bypassed the editor preparation', async actionIdentifier => {
        disclosure = null;
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture_4', requestId: 'raw-unprepared-delivery', actionIdentifier,
            data: { captureRef: captured.captureRef, session: target } }, createDefaultActionExecutor({ screenCaptureWindowPress: true }));
        expect(emitted.at(-1)).toMatchObject({ phase: 'settled', ok: false, errorCode: 'capture_not_prepared' });
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toEqual([]);
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId })?.text).toBe('Existing words');
        expect(commands).not.toContain('desktop_capture_read_prepared_png');
        expect(commands).not.toContain('desktop_capture_retain_prepared_png');
        expect(commands).not.toContain('desktop_capture_read_source_png');
        expect(commands).not.toContain('desktop_capture_settle');
    });

    it('pins an omitted destination from the focused eligible Session in its active Account', async () => {
        storage.setState({ sessionListRowsByServerId: { [target.serverId]: {
            [target.sessionId]: createSessionListRenderableSessionFixture({ id: target.sessionId }),
        } }, ordinarySessionListMembershipByServerId: { [target.serverId]: [target.sessionId] } });
        setFocusedSessionId(target.sessionId, target.serverId);
        expect(await createDefaultActionExecutor().execute('screenCapture.open', { captureRef: captured.captureRef },
            { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: true });
        expect(openedTarget).toEqual(target);
        expect(commands).toEqual(['desktop_capture_read_state', 'desktop_capture_open']);
    });

    it.each([
        { actionId: 'screenCapture.addToDraft', retry: false },
        { actionId: 'screenCapture.send', retry: false },
        { actionId: 'screenCapture.send', retry: true },
    ] as const)('refuses image-incompatible delivery before reading pixels or changing the draft ($actionId, retry=$retry)', async ({ actionId, retry }) => {
        storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId,
            [target.serverId]: { [target.sessionId]: createSessionListRenderableSessionFixture({
                id: target.sessionId, imageInputAvailability: { available: false, reason: 'image_input_unsupported' },
            }) },
        } }));
        expect(await createDefaultActionExecutor({ screenCaptureWindowPress: true, screenCaptureSendDraftOnly: retry }).execute(actionId, {
            captureRef: captured.captureRef, session: target, note: 'Must not be appended',
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: 'image_input_unsupported' });
        expect(commands).not.toContain('desktop_capture_read_prepared_png');
        expect(commands).not.toContain('desktop_capture_retain_prepared_png');
        expect(commands).not.toContain('desktop_capture_read_source_png');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(0);
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId })?.text).toBe('Existing words');
    });

    it.each(['draft', 'frontmost-explicit', 'frontmost-default'] as const)('refuses an opened dispatcher publication without a compact target row (%s)', async ingress => {
        inUse = false;
        storage.setState(state => ({ sessions: { ...state.sessions, [target.sessionId]: createSessionFixture({
            id: target.sessionId, serverId: target.serverId, metadata: { ...createSessionFixture().metadata!, agentRuntimeCapabilitiesV1: {
                backend: { session: { media: { acceptsImageInput: { supported: false } } } },
            } },
        }) } }));
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.start': ['agent'] } });
        const agent = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction(),
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) });
        const outcome = ingress === 'draft'
            ? await createDefaultActionExecutor({ screenCaptureWindowPress: true }).execute('screenCapture.addToDraft', {
                captureRef: captured.captureRef, session: target,
            }, { surface: 'ui', serverId: target.serverId })
            : await agent.execute('screenCapture.start', { mode: 'screenshot', target: { kind: 'frontmost' },
                ...(ingress === 'frontmost-explicit' ? { targetSession: target } : {}),
            }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: target.serverId,
                runtimeAccountId: target.accountId, defaultSessionId: target.sessionId, defaultSessionMachineId: 'client' });
        expect(outcome).toMatchObject({ ok: false, errorCode: 'image_input_unsupported' });
        expect(commands).not.toContain('desktop_capture_read_prepared_png');
        expect(commands).not.toContain('desktop_capture_retain_prepared_png');
        expect(commands).not.toContain('desktop_capture_read_source_png');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(0);
    });

    it.each([undefined, true])('appends prepared pixels once for an allowed or unpublished dispatcher (%s)', async supported => {
        storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId,
            [target.serverId]: { [target.sessionId]: createSessionListRenderableSessionFixture({
                id: target.sessionId,
                ...(supported === undefined ? {} : { imageInputAvailability: { available: true } }),
            }) },
            // A same-id Session in another Home must not decide this target's admission.
            'another-home': { [target.sessionId]: createSessionListRenderableSessionFixture({
                id: target.sessionId, imageInputAvailability: { available: false, reason: 'image_input_unsupported' },
            }) },
        } }));
        const executor = createDefaultActionExecutor({ screenCaptureWindowPress: true });
        expect(commands).toEqual([]);
        expect(await executor.execute('screenCapture.addToDraft', { captureRef: captured.captureRef, session: target, note: 'Look here' },
            { surface: 'ui', serverId: target.serverId })).toEqual({ ok: true,
                result: { captureRef: captured.captureRef, imageNumber: 1, waiting: false } });
        const drafts = readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]?.source).toMatchObject({ kind: 'memory', bytes: new Uint8Array([4, 5, 6]), mimeType: 'image/png' });
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId })?.text).toMatch(/^Existing words\n\n.*Look here$/);
        expect(commands.filter(command => command === 'desktop_capture_retain_prepared_png')).toHaveLength(1);
        expect(commands.filter(command => command === 'desktop_capture_settle')).toHaveLength(1);
        expect(commands).not.toContain('desktop_capture_discard');
        expect(commands.filter(command => command === 'desktop_capture_read_source_png')).toHaveLength(1);
    });

    it.each(['ready', 'partial'] as const)('admits included sanitized %s text as an unnumbered file beside the prepared image', async status => {
        disclosure = { hasMarks: true, includeWindowText: true };
        const text = 'Chosen window text\nVisible line';
        const source = { appName: 'Editor', windowTitle: 'Chosen window', windowId: 7 };
        cachedWindowText = status === 'ready' ? { status, text, source }
            : { status, text, source, reason: 'provider_unavailable' };
        expect(await createDefaultActionExecutor({ screenCaptureWindowPress: true }).execute('screenCapture.addToDraft', {
            captureRef: captured.captureRef, session: target,
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: true,
            result: { captureRef: captured.captureRef, imageNumber: 1 } });
        const drafts = readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target));
        expect(drafts).toHaveLength(2);
        expect(drafts[1]?.source).toMatchObject({ kind: 'memory', mimeType: 'text/plain', bytes: new TextEncoder().encode(text) });
        expect(drafts[1]?.source.kind === 'memory' && drafts[1].source.name).toContain('Editor');
        const snapshot = readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId });
        expect(snapshot?.references).toHaveLength(1);
        expect(snapshot?.text).not.toContain(text);
        expect(commands).not.toContain('desktop_capture_window_text');
        expect(commands.filter(command => command === 'desktop_capture_retain_prepared_png')).toHaveLength(1);
    });

    it('keeps excluded cached window text out of the draft without a fresh extraction', async () => {
        cachedWindowText = { status: 'ready', text: 'Excluded text', source: null };
        expect(await createDefaultActionExecutor({ screenCaptureWindowPress: true }).execute('screenCapture.addToDraft', {
            captureRef: captured.captureRef, session: target,
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: true });
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(1);
        expect(commands).not.toContain('desktop_capture_window_text');
    });

    it('refuses another UI caller while the capture is open before reading pixels', async () => {
        expect(await createDefaultActionExecutor().execute('screenCapture.addToDraft', {
            captureRef: captured.captureRef, session: target,
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        expect(commands).not.toContain('desktop_capture_read_prepared_png');
        expect(commands).not.toContain('desktop_capture_retain_prepared_png');
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(0);
    });

    it('retries a settled submission refusal without reading or appending the staged capture again', async () => {
        homes.answer(target.serverId, '/v1/machines', { body: [] });
        const input = { captureRef: captured.captureRef, session: target, note: 'One capture note' };
        const first = await createDefaultActionExecutor({ screenCaptureWindowPress: true }).execute('screenCapture.send', input,
            { surface: 'ui', serverId: target.serverId });
        expect(first).toMatchObject({ ok: false, details: { captureStaged: true } });
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(1);
        const staged = readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId });
        preparedMissing = true;
        const retried = await createDefaultActionExecutor({ screenCaptureWindowPress: true, screenCaptureSendDraftOnly: true })
            .execute('screenCapture.send', input, { surface: 'ui', serverId: target.serverId });
        expect(retried).toMatchObject({ ok: false, details: { captureStaged: true } });
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(1);
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: target.sessionId })).toEqual(staged);
        expect(commands.filter(command => command === 'desktop_capture_retain_prepared_png')).toHaveLength(1);
        expect(commands).not.toContain('desktop_capture_settle');
    });

    it('preserves the accepted draft outcome if the native settlement fails afterwards', async () => {
        settleFailed = true;
        expect(await createDefaultActionExecutor({ screenCaptureWindowPress: true }).execute('screenCapture.addToDraft', {
            captureRef: captured.captureRef, session: target,
        }, { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: 'native_failure',
            effectAttempted: true, details: { captureStaged: true,
                delivered: { captureRef: captured.captureRef, imageNumber: 1, waiting: false } } });
        expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(target))).toHaveLength(1);
    });

    it.each(['ui', 'agent'] as const)('opens through the native operation owner and discards through its %s settled native owner', async surface => {
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('screenCapture.open', { captureRef: captured.captureRef, targetSession: target }, { surface: 'ui', serverId: target.serverId }))
            .toEqual({ ok: true, result: { captureRef: captured.captureRef, status: 'opened', targetSession: target } });
        expect(openedTarget).toEqual(target);
        expect(await executor.execute('screenCapture.discard', { captureRef: captured.captureRef }, { surface,
            authority: surface === 'ui' ? 'present_user' : 'account_automation', actionCaller: { kind: 'host' },
            serverId: target.serverId, runtimeAccountId: target.accountId, defaultSessionMachineId: 'client' }))
            .toEqual({ ok: true, result: { captureRef: captured.captureRef, status: 'discarded' } });
        expect(commands).toEqual(['desktop_capture_open', 'desktop_capture_discard']);
    });

    it('preserves a native discard file failure without settling or reporting discarded', async () => {
        discardFailed = true;
        expect(await createDefaultActionExecutor().execute('screenCapture.discard', { captureRef: captured.captureRef },
            { surface: 'ui', serverId: target.serverId })).toMatchObject({ ok: false, errorCode: 'file_io' });
        expect(commands).toEqual(['desktop_capture_discard']);
    });

    it('settles the admitted agent start from the real default discard receipt after its UI hold', async () => {
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.start': ['agent'] } });
        const agent = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction(),
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) });
        const controller = new AbortController();
        const pending = agent.execute('screenCapture.start', { mode: 'screenshot', targetSession: target }, {
            surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: target.serverId,
            runtimeAccountId: target.accountId, defaultSessionMachineId: 'client', signal: controller.signal,
        });
        try {
            await vi.waitFor(() => expect(commands).toContain('desktop_capture_start'));
            emitNative('desktopCapture://state', { status: 'completed', operationRef: 1, result: captured, targetSession: target });
            expect(commands).not.toContain('desktop_capture_discard');
            await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'undo-hold-ended',
                actionIdentifier: 'screenCapture.discard', data: { captureRef: captured.captureRef } },
                createDefaultActionExecutor({ screenCaptureWindowPress: true }));
            expect(emitted.at(-1)).toMatchObject({ phase: 'settled', ok: true,
                result: { captureRef: captured.captureRef, status: 'discarded' } });
            expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(commands.filter(command => command === 'desktop_capture_discard')).toHaveLength(1);
            expect([...events.values()].every(handlers => handlers.size === 0)).toBe(true);
        } finally { controller.abort(); await pending; }
    });
});
