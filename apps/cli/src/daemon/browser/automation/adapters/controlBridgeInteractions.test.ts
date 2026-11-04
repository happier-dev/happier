import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type BrowserAutomationActionKindV1, type RuntimeActionIdV1 } from '@happier-dev/protocol';
import { BrowserAutomationActionResultV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import { createBrowserSidecarCdpControlAdapterFactory } from '../../sidecar/controlAdapterFactory';
import type { BrowserSidecarCdpEventCapableTransport, BrowserSidecarCdpEventSubscriber } from '../../sidecar/controlAdapter';
import { createControlAdapterAutomationTransport } from './controlBridge';
import { createBrowserAutomationCdpAdapter } from './cdp';
import { createBrowserAutomationDaemonService } from '../service';
import { createBrowserAutomationRoutes } from '../routes';
import { createDaemonRuntimeActionExecutor } from '../../../runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '../../control/broker';
import { createBrowserDaemonControlRoutes } from '../../control/routes';
import { createSnapshotCaptureTestRoutes, createSnapshotMaskingFixture } from '../../context/cdp/snapshotMasking.testkit';
import { browserContextSensitiveFieldsExpression } from '@happier-dev/protocol/browser/context/privacy';
import { createDaemonControlApp } from '../../../controlServer';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from '../../actions/controlTransport';
import { buildDaemonControlHttpHeaders } from '../../../controlHttp';
import type { TrackedSession } from '../../../types';

async function harness() {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const bytes = Buffer.from([0, 255, 128, 65]);
    const state = { pageText: 'public page', downloadPath: '', uploaded: Buffer.alloc(0), uploadPath: '', uploadPaths: [] as string[], rejectUpload: false, openNextDialogOnAnswer: false, onKeyDown: () => {} };
    const emit = (method: string, params: Record<string, unknown>, sessionId = 'page') => {
        for (const listener of [...listeners]) listener({ method, params, sessionId });
    };
    // Chromium/CDP and its filesystem staging are the only substituted boundary.
    const transport: BrowserSidecarCdpEventCapableTransport = {
        openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
        async dispatchPageCommand(command) {
            commands.push(command);
            if (command.method === 'Page.navigate' && typeof command.params?.url === 'string') {
                const url = new URL(command.params.url.startsWith('view-source:') ? command.params.url.slice('view-source:'.length) : command.params.url);
                state.pageText = url.protocol === 'file:' ? await readFile(fileURLToPath(url), 'utf8') : 'public page';
            }
            if (command.method === 'DOMSnapshot.captureSnapshot') return createSnapshotMaskingFixture([{ text: true, value: state.pageText }]);
            if (command.method === 'Accessibility.getFullAXTree') return { nodes: [] };
            if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'https://example.test/' } } };
            if (command.method === 'Runtime.evaluate') {
                if (command.params?.expression === browserContextSensitiveFieldsExpression) return { result: { value: false } };
                if (String(command.params?.expression).includes('document.body')) return { result: { type: 'string', value: state.pageText } };
                if (command.params?.returnByValue === false) return { result: { objectId: 'file-input' } };
                if (String(command.params?.expression).includes('getBoundingClientRect')) return { result: { value: { x: 20, y: 30 } } };
                return { result: { value: command.params?.expression === 'document.readyState' ? 'complete' : 'private clipboard' } };
            }
            if (command.method === 'Input.dispatchKeyEvent' && command.params?.type === 'keyDown') state.onKeyDown();
            if (command.method === 'DOM.setFileInputFiles') {
                const files = command.params?.files;
                if (Array.isArray(files) && typeof files[0] === 'string') {
                    state.uploadPaths = files.filter((file): file is string => typeof file === 'string');
                    state.uploadPath = files[0];
                    state.uploaded = await readFile(files[0]);
                }
                if (state.rejectUpload) throw new Error('CDP selection rejected');
            }
            if (command.method === 'Page.handleJavaScriptDialog' && state.openNextDialogOnAnswer) {
                state.openNextDialogOnAnswer = false;
                emit('Page.javascriptDialogOpening', { type: 'alert', message: 'next manual dialog' });
            }
            return {};
        },
        async dispatchBrowserCommand(command) {
            commands.push(command);
            if (command.method === 'Browser.setDownloadBehavior') state.downloadPath = String(command.params?.downloadPath);
            return { success: true };
        },
        subscribeCdpEvents(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
        pipe: { readable: new PassThrough(), writable: new PassThrough() },
        connectTransport: async () => ({ transport }) });
    const created = await factory({ machineId: 'machine' });
    if (!created.ok) throw new Error(created.errorCode);
    const view = { browserSessionId: 'browser', viewId: 'view' };
    await created.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', focus: true, platform: 'web',
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
    const browserContext = created.contextCapture ? createSnapshotCaptureTestRoutes(created.contextCapture) : undefined;
    const bridge = createControlAdapterAutomationTransport({ adapter: created.adapter, contextCapture: created.contextCapture, browserContext });
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
    let request = 0;
    const execute = (actionKind: BrowserAutomationActionKindV1, payload: Record<string, unknown> = {}, context?: { signal?: AbortSignal }) => service.execute({
        v: 1, ...view, automationRequestId: `request:${++request}`, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent' },
        navigationGeneration: created.contextCapture?.getNavigationState?.(view)?.navigationGeneration ?? 0,
        actionKind, payload, timeoutMs: 10_000,
    }, context);
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(created.adapter);
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({
        env: {},
        resolveRouteOwners: () => ({
            browserControl: createBrowserDaemonControlRoutes({ broker, automation: () => service }),
            browserAutomation: createBrowserAutomationRoutes({ service }),
            browserUiAutomation: { ownsAutomationView: broker.ownsView, uiAutomation: createUnavailableRuntimeActionExecutor() },
        }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
            browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
                sidecar: { enabled: true }, context: { enabled: true }, automation: { enabled: true } },
        } }) }),
    });
    return { service, created, view, bytes, state, commands, emit, execute, runtimeActionExecute,
        async dispose() { service.dispose(); await created.dispose?.(); } };
}

describe('browser interaction Action bridge', () => {
    it.each(['use', undefined, 'manage', 'owner'] as const)('keeps owner file bytes out of a non-Manage Session (%s)', async role => {
        const h = await harness();
        const directory = await mkdtemp(join(tmpdir(), 'browser-owner-file-'));
        const path = join(directory, 'owner-only.txt');
        const secret = 'owner-only-file-sentinel';
        await writeFile(path, secret, { mode: 0o600 });
        // Private custody is daemon lifecycle state, shaped like SEC-FIX-CU's Session fixture.
        const child = { startedBy: 'daemon', happySessionId: 'browser', pid: 4242,
            ...(role === 'owner' ? {} : { requesterSessionRuntimeContext: { bootstrap: {
                savedSecretOperationContext: { machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner',
                    ...(role ? { role } : {}) } },
            } } }),
        } as unknown as TrackedSession;
        const app = createDaemonControlApp({ getChildren: () => [child], machineId: 'machine',
            stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'browser-file-test',
            runtimeActionExecute: h.runtimeActionExecute });
        let request = 0;
        const requestAction = (actionId: RuntimeActionIdV1, input: Record<string, unknown>) =>
            app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
                headers: buildDaemonControlHttpHeaders('browser-file-test'), payload: { actionId, input, sessionId: 'browser' } });
        const call = async (actionId: RuntimeActionIdV1, input: Record<string, unknown>) => {
            const response = await requestAction(actionId, input);
            expect(response.statusCode).toBe(200);
            return response.json().result;
        };
        const automate = (actionKind: 'navigate' | 'snapshot' | 'upload', payload: Record<string, unknown> = {}) =>
            call(`browser.automation.${actionKind}`, { v: 1, ...h.view,
                automationRequestId: `guest-file:${++request}`, navigationGeneration: h.created.contextCapture?.getNavigationState?.(h.view)?.navigationGeneration ?? 0,
                requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'guest-agent' }, actionKind, payload, timeoutMs: 10_000 });
        try {
            const noPayload = await requestAction('browser.automation.navigate', { v: 1, ...h.view,
                automationRequestId: 'missing-payload', navigationGeneration: 0, requestedBy: 'agent',
                requesterRef: { kind: 'agent', id: 'guest-agent' }, actionKind: 'navigate', timeoutMs: 10_000 });
            expect(noPayload.statusCode).toBe(200);
            expect(noPayload.json().result).toMatchObject({ status: 'failed', errorCode: 'unsupported_action' });
            expect(await automate('navigate', { url: 'https://example.test/' })).toMatchObject({ status: 'succeeded' });
            expect(await automate('navigate', { url: 'http://example.test/' })).toMatchObject({ status: 'succeeded' });
            expect(await automate('navigate', { url: 'about:blank' })).toMatchObject({ status: 'succeeded' });
            // Direct control already uses the canonical HTTP(S) URL schema.
            expect((await requestAction('browser.navigate', { ...h.view, kind: 'navigate', commandId: 'file-direct', url: pathToFileURL(path).href })).statusCode)
                .toBe(400);
            const navigation = await automate('navigate', { url: pathToFileURL(path).href });
            const snapshot = await automate('snapshot');
            if (role === 'manage' || role === 'owner') {
                expect(navigation).toMatchObject({ status: 'succeeded' });
                expect(JSON.stringify(snapshot)).toContain(secret);
            } else {
                // Assert disclosure first: this RED reports returned bytes, not just dispatch.
                expect(JSON.stringify(snapshot)).not.toContain(secret);
                expect(navigation).toMatchObject({ ok: false, errorCode: 'access_denied' });
                expect(await automate('navigate', { url: ` \nFiLe:${pathToFileURL(path).href.slice(5)}` }))
                    .toMatchObject({ ok: false, errorCode: 'access_denied' });
                expect(h.commands.filter(command => command.method === 'Page.navigate'
                    && new URL(String(command.params?.url)).protocol === 'file:')).toHaveLength(0);
            }
            for (const url of [`view-source:${pathToFileURL(path).href}`, 'chrome://version/', 'devtools://devtools/']) {
                const result = await automate('navigate', { url });
                if (role === 'manage' || role === 'owner') {
                    expect(result).toMatchObject({ status: 'succeeded' });
                } else {
                    expect(JSON.stringify(await automate('snapshot'))).not.toContain(secret);
                    expect(result).toMatchObject({ ok: false, errorCode: 'access_denied' });
                }
            }
            for (const payload of [
                { selector: '#file', files: [path] },
                { selector: '#file', files: [{ name: 'owner-only.txt', path }] },
                { selector: '#file', files: [{ name: path, text: '' }] },
            ]) expect(await automate('upload', payload)).toMatchObject({ status: 'failed', errorCode: 'unsupported_action' });
            h.emit('Page.fileChooserOpened', { backendNodeId: 44, mode: 'selectSingle' });
            const chooserId = h.created.contextCapture?.interactions?.getState(h.view)?.fileChooser?.chooserId;
            expect((await requestAction('browser.automation.upload', { v: 1, ...h.view, automationRequestId: 'bad-chooser',
                navigationGeneration: h.created.contextCapture?.getNavigationState?.(h.view)?.navigationGeneration ?? 0,
                requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'guest-agent' }, actionKind: 'upload', timeoutMs: 10_000,
                payload: { chooserId, files: [{ name: 'owner-only.txt', path }] } })).statusCode).toBe(400);
            expect(h.state.uploaded).toHaveLength(0);
            expect(await automate('upload', { selector: '#file', files: [{ name: 'own.txt', path, text: 'guest-supplied' }] }))
                .toMatchObject({ status: 'succeeded' });
            expect(h.state.uploaded.toString()).toBe('guest-supplied');
            expect(await automate('upload', { chooserId, files: [{ name: 'own.bin', dataBase64: h.bytes.toString('base64') }] }))
                .toMatchObject({ status: 'succeeded' });
            expect(h.state.uploaded).toEqual(h.bytes);
        } finally { await app.close(); await h.dispose(); await rm(directory, { recursive: true, force: true }); }
    });

    it('admits Cut as an edit and refuses a stale page without deleting its selection', async () => {
        const h = await harness();
        try {
            h.commands.length = 0;
            const result = await h.service.execute({ v: 1, ...h.view, automationRequestId: 'stale-cut',
                requestedBy: 'user', requesterRef: { kind: 'streamViewer', id: 'viewer' }, navigationGeneration: 99,
                actionKind: 'clipboardCut', payload: {}, timeoutMs: 10_000 });
            expect(result).toMatchObject({ status: 'failed', errorCode: 'stale_navigation' });
            expect(h.commands.filter(command => command.method === 'Runtime.evaluate')).toEqual([]);
        } finally { await h.dispose(); }
    });
    it('preserves key modifiers through normal release and interrupted cleanup', async () => {
        const h = await harness();
        try {
            expect(await h.execute('press', { key: 'A', modifiers: ['control', 'shift'] })).toMatchObject({ status: 'succeeded' });
            expect(h.commands.filter(command => command.method === 'Input.dispatchKeyEvent').map(command => command.params))
                .toEqual([{ type: 'keyDown', key: 'A', modifiers: 10, windowsVirtualKeyCode: 65 },
                    { type: 'keyUp', key: 'A', modifiers: 10, windowsVirtualKeyCode: 65 }]);
            h.commands.length = 0;
            const abort = new AbortController();
            h.state.onKeyDown = () => abort.abort('stop');
            expect(await h.execute('press', { key: 'B', modifiers: ['alt', 'meta'] }, { signal: abort.signal }))
                .toMatchObject({ status: 'canceled' });
            expect(h.commands.filter(command => command.method === 'Input.dispatchKeyEvent').map(command => command.params))
                .toEqual([{ type: 'keyDown', key: 'B', modifiers: 5, windowsVirtualKeyCode: 66 },
                    { type: 'keyUp', key: 'B', modifiers: 5, windowsVirtualKeyCode: 66 }]);
        } finally { await h.dispose(); }
    });

    it('returns typed clipboard/download bytes and keeps them out of summaries and timelines', async () => {
        const h = await harness();
        try {
            const clipboard = await h.execute('clipboardRead');
            expect(clipboard).toMatchObject({ status: 'succeeded', interactionResult: { kind: 'clipboard', text: 'private clipboard' } });
            expect(BrowserAutomationActionResultV1Schema.safeParse(clipboard).success).toBe(true);
            expect(clipboard.resultSummary).toEqual({});
            const cut = await h.execute('clipboardCut');
            expect(cut).toMatchObject({ status: 'succeeded', interactionResult: { kind: 'clipboard', text: 'private clipboard' } });
            expect(cut.resultSummary).toEqual({});
            expect(await h.execute('clipboardWrite', { text: 'private paste' })).toMatchObject({ status: 'succeeded' });
            expect(h.commands).toContainEqual(expect.objectContaining({ method: 'Input.insertText', params: { text: 'private paste' } }));
            await vi.waitFor(() => expect(h.state.downloadPath).not.toBe(''));
            h.emit('Browser.downloadWillBegin', { frameId: 'frame', guid: 'download', suggestedFilename: 'private.bin' });
            await writeFile(join(h.state.downloadPath, 'download'), h.bytes);
            h.emit('Browser.downloadProgress', { guid: 'download', state: 'completed', receivedBytes: 4, totalBytes: 4 });
            const download = await h.execute('download', { downloadId: 'download', offset: 1, byteLength: 2 });
            expect(download).toMatchObject({ status: 'succeeded', interactionResult: { kind: 'download', dataBase64: '/4A=', eof: false, offset: 1 } });
            expect(download.resultSummary).toEqual({});
            const timeline = JSON.stringify(h.service.getTimeline(h.view));
            for (const secret of ['private clipboard', 'private paste', '/4A=', 'dataBase64']) expect(timeline).not.toContain(secret);
        } finally { await h.dispose(); }
    });

    it('returns pending dialog state without persisting it and answers only the requested dialog', async () => {
        const h = await harness();
        try {
            h.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'private dialog message', defaultPrompt: 'private default' });
            const state = await h.execute('getInteractionState');
            expect(state).toMatchObject({ status: 'succeeded', resultSummary: { dialog: { message: 'private dialog message', defaultPrompt: 'private default' } } });
            const dialogId = h.created.contextCapture?.interactions?.getState(h.view)?.dialog?.dialogId;
            h.state.openNextDialogOnAnswer = true;
            expect(await h.execute('answerDialog', { dialogId, accept: true, promptText: 'private answer' })).toMatchObject({ status: 'succeeded' });
            expect(h.commands.filter(command => command.method === 'Page.handleJavaScriptDialog')).toEqual([
                expect.objectContaining({ params: { accept: true, promptText: 'private answer' } }),
            ]);
            expect(h.created.contextCapture?.interactions?.getState(h.view)?.dialog?.message).toBe('next manual dialog');
            const timeline = JSON.stringify(h.service.getTimeline(h.view));
            for (const secret of ['private dialog message', 'private default', 'private answer', 'defaultPrompt', 'promptText']) expect(timeline).not.toContain(secret);
        } finally { await h.dispose(); }
    });

    it('routes chooser uploads through the live owner and leaves file content out of timelines', async () => {
        const h = await harness();
        try {
            h.emit('Page.fileChooserOpened', { backendNodeId: 44, mode: 'selectSingle' });
            const chooserId = h.created.contextCapture?.interactions?.getState(h.view)?.fileChooser?.chooserId;
            expect(await h.execute('upload', { chooserId, files: [{ name: 'private-upload.bin', dataBase64: h.bytes.toString('base64') }] }))
                .toMatchObject({ status: 'succeeded' });
            expect(h.state.uploaded).toEqual(h.bytes);
            const timeline = JSON.stringify(h.service.getTimeline(h.view));
            expect(timeline).not.toContain(h.bytes.toString('base64'));
            expect(timeline).not.toContain('private-upload.bin');
        } finally { await h.dispose(); }
    });

    it('keeps selector upload backing bytes available until the owning view closes', async () => {
        const h = await harness();
        try {
            expect(await h.execute('upload', { selector: '#file', files: [{ name: 'upload.bin', text: h.bytes.toString('base64'), base64: true }] }))
                .toMatchObject({ status: 'succeeded' });
            expect(await readFile(h.state.uploadPath)).toEqual(h.bytes);
            await h.created.adapter.dispatchCommand({ ...h.view, kind: 'closeView', commandId: 'close' });
            await vi.waitFor(async () => expect(await readFile(h.state.uploadPath).then(() => 'exists', () => 'removed')).toBe('removed'));
        } finally { await h.dispose(); }
    });

    it('preserves duplicate-name binary uploads and reclaims them on close after a selection failure', async () => {
        const h = await harness();
        try {
            h.state.rejectUpload = true;
            const descriptor = { name: 'same.bin', text: h.bytes.toString('base64'), base64: true };
            expect(await h.execute('upload', { selector: '#file', files: [descriptor, descriptor] }))
                .toMatchObject({ status: 'failed', errorCode: 'runtime_unavailable' });
            expect(h.state.uploadPaths).toHaveLength(2);
            expect(h.state.uploadPaths[0]).not.toBe(h.state.uploadPaths[1]);
            for (const path of h.state.uploadPaths) expect(await readFile(path)).toEqual(h.bytes);
            await h.created.adapter.dispatchCommand({ ...h.view, kind: 'closeView', commandId: 'close' });
            for (const path of h.state.uploadPaths) {
                await vi.waitFor(async () => expect(await readFile(path).then(() => 'exists', () => 'removed')).toBe('removed'));
            }
        } finally { await h.dispose(); }
    });
});
