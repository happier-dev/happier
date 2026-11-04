import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    BrowserUploadFileV1Schema,
    type BrowserAutomationActionKindV1,
    type BrowserAutomationErrorCodeV1,
    type BrowserInteractionResultV1,
    type BrowserInteractionStateV1,
} from '@happier-dev/protocol';
import { browserAutomationInteractionPayloadSchema } from '@happier-dev/protocol/browser/automation/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type {
    BrowserSidecarCdpCommandScope,
    BrowserSidecarCdpEventCapableTransport,
    BrowserSidecarCdpEventNotification,
    BrowserSidecarCdpPageHandle,
    BrowserSidecarViewLifecycleSubscriber,
} from './controlAdapter';

type View = Readonly<{ browserSessionId: string; viewId: string }>;
export type BrowserSidecarInteractionRequest = View & BrowserSidecarCdpCommandScope & Readonly<{
    actionKind: BrowserAutomationActionKindV1;
    payload: Readonly<Record<string, unknown>>;
}>;
export type BrowserSidecarInteractionResult =
    | Readonly<{ ok: true; data?: Readonly<Record<string, unknown>>; interactionResult?: BrowserInteractionResultV1 }>
    | Readonly<{ ok: false; errorCode: BrowserAutomationErrorCodeV1 }>;
export type BrowserSidecarInteractions = Readonly<{
    getState(view: View): BrowserInteractionStateV1 | null;
    subscribe(listener: (view: View) => void): () => void;
    execute(request: BrowserSidecarInteractionRequest): Promise<BrowserSidecarInteractionResult>;
    stageUpload(view: View, files: readonly Readonly<{ name: string; bytes: Uint8Array }>[]): Promise<readonly string[]>;
    dispose(): Promise<void>;
}>;

type LiveView = {
    view: View;
    state: BrowserInteractionStateV1;
    frames: Map<string, string | undefined>;
    chooserNodeId?: number;
    uploads: Set<Readonly<{ dispose(): Promise<void> }>>;
};

const observedMethods = new Set([
    'Browser.downloadWillBegin', 'Browser.downloadProgress', 'Page.fileChooserOpened',
    'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Page.frameNavigated',
    'Page.frameAttached', 'Page.frameDetached',
]);

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Copy the selection, including editable text selections, without revealing masked fields.
const selectedTextExpression = `(cut => {
    const masked = element => {
        if (element.type === 'password' || element.closest('input[type="password"]')) return true;
        const security = getComputedStyle(element).webkitTextSecurity;
        return typeof security === 'string' && security !== 'none' && security !== '';
    };
    const element = document.activeElement;
    if (element && masked(element)) return '';
    const field = element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
        && typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number';
    const finish = text => {
        if (cut && text && element && ((field && !element.readOnly && !element.disabled) || element.isContentEditable)) {
            // Use Chromium's editor to preserve undo history while deleting the selection.
            if (!document.execCommand('delete')) throw new Error('cut_unavailable');
        }
        return text;
    };
    if (field) return finish(element.value.slice(element.selectionStart, element.selectionEnd));
    const selection = window.getSelection();
    if (selection) {
        for (const node of [selection.anchorNode, selection.focusNode]) {
            const parent = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
            if (parent && masked(parent)) return '';
        }
        for (let index = 0; index < selection.rangeCount; index++) {
            const range = selection.getRangeAt(index);
            const node = range.commonAncestorContainer;
            const root = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            const containsMasked = current => {
                if (!range.intersectsNode(current)) return false;
                if (masked(current)) return true;
                for (const child of current.children) if (containsMasked(child)) return true;
                return false;
            };
            if (root && containsMasked(root)) return '';
        }
    }
    return finish(selection ? selection.toString() : '');
})`;

/** One byte-staging owner for selector and intercepted-chooser uploads. */
export async function stageBrowserUploadFiles(files: readonly Readonly<{ name: string; bytes: Uint8Array }>[]) {
    const path = await mkdtemp(join(tmpdir(), 'happier-browser-upload-'));
    try {
        const paths: string[] = [];
        for (const [index, file] of files.entries()) {
            BrowserUploadFileV1Schema.shape.name.parse(file.name);
            const parent = join(path, String(index));
            await mkdir(parent);
            const filePath = join(parent, file.name);
            await writeFile(filePath, file.bytes);
            paths.push(filePath);
        }
        return { paths, dispose: () => rm(path, { recursive: true, force: true }) };
    } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
    }
}

export function createBrowserSidecarInteractions(input: Readonly<{
    transport: BrowserSidecarCdpEventCapableTransport;
    resolvePageHandle(view: View): BrowserSidecarCdpPageHandle | null;
    subscribeViewLifecycle(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
}>): BrowserSidecarInteractions {
    const views = new Map<string, LiveView>();
    const listeners = new Set<(view: View) => void>();
    const work = new Set<Promise<unknown>>();
    let unsubscribeEvents: (() => void) | undefined;
    let directory: Promise<string> | undefined;
    let downloadSetupUnavailable = false;
    let disposed = false;
    const key = browserViewKey;
    const track = (task: Promise<unknown>) => {
        work.add(task);
        void task.catch(() => {}).finally(() => work.delete(task));
    };
    const notify = (live: LiveView) => {
        for (const listener of listeners) {
            try { listener(live.view); } catch { /* A subscriber cannot break CDP event delivery. */ }
        }
    };
    const update = (live: LiveView, state: BrowserInteractionStateV1) => {
        live.state = state;
        notify(live);
    };
    const markUnavailable = (live: LiveView, capability: 'download' | 'fileChooser') => {
        if (disposed || views.get(key(live.view)) !== live || live.state.unavailable?.[capability]) return;
        update(live, { ...live.state, unavailable: { ...live.state.unavailable, [capability]: 'runtime_unavailable' } });
    };
    const downloadDirectory = () => directory ??= mkdtemp(join(tmpdir(), 'happier-browser-download-'));
    const setDownloadBehavior = async (enabled: boolean) => {
        const downloadPath = enabled ? await downloadDirectory() : undefined;
        if (enabled && (disposed || views.size === 0)) return;
        await input.transport.dispatchBrowserCommand({ method: 'Browser.setDownloadBehavior', params: enabled
            ? { behavior: 'allowAndName', downloadPath, eventsEnabled: true }
            : { behavior: 'default', eventsEnabled: false } });
        // A close during directory creation or the command must not leave idle collection enabled.
        if (enabled && (disposed || views.size === 0)) await setDownloadBehavior(false);
    };
    const addFrameTree = (live: LiveView, tree: unknown) => {
        const entry = record(tree);
        const frame = record(entry.frame);
        if (typeof frame.id === 'string') live.frames.set(frame.id, typeof frame.parentId === 'string' ? frame.parentId : undefined);
        if (Array.isArray(entry.childFrames)) for (const child of entry.childFrames) addFrameTree(live, child);
    };
    const receive = (event: BrowserSidecarCdpEventNotification) => {
        if (!observedMethods.has(event.method)) return;
        const params = event.params ?? {};
        for (const live of views.values()) {
            if (event.method === 'Browser.downloadWillBegin') {
                if (typeof params.frameId !== 'string' || !live.frames.has(params.frameId)
                    || typeof params.guid !== 'string' || !BrowserUploadFileV1Schema.shape.name.safeParse(params.guid).success
                    || typeof params.suggestedFilename !== 'string' || live.state.downloads.some((item) => item.downloadId === params.guid)) continue;
                update(live, { ...live.state, downloads: [...live.state.downloads, {
                    downloadId: params.guid, name: params.suggestedFilename, state: 'inProgress', receivedBytes: 0, totalBytes: 0,
                }] });
                continue;
            }
            if (event.method === 'Browser.downloadProgress') {
                const previous = live.state.downloads.find((item) => item.downloadId === params.guid);
                if (!previous || !['inProgress', 'completed', 'canceled'].includes(String(params.state))
                    || typeof params.receivedBytes !== 'number' || !Number.isFinite(params.receivedBytes) || params.receivedBytes < 0
                    || typeof params.totalBytes !== 'number' || !Number.isFinite(params.totalBytes) || params.totalBytes < 0) continue;
                if (previous.state === params.state && previous.receivedBytes === params.receivedBytes && previous.totalBytes === params.totalBytes) continue;
                update(live, { ...live.state, downloads: live.state.downloads.map((item) => item === previous
                    ? { ...item, state: params.state as typeof item.state, receivedBytes: params.receivedBytes as number, totalBytes: params.totalBytes as number } : item) });
                continue;
            }
            const handle = input.resolvePageHandle(live.view);
            if (!handle || event.sessionId !== handle.sessionId) continue;
            if (event.method === 'Page.fileChooserOpened' && typeof params.backendNodeId === 'number') {
                live.chooserNodeId = params.backendNodeId;
                update(live, { ...live.state, fileChooser: { chooserId: randomUUID(), multiple: params.mode === 'selectMultiple' } });
            } else if (event.method === 'Page.javascriptDialogOpening'
                && ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(params.type)) && typeof params.message === 'string') {
                update(live, { ...live.state, dialog: {
                    dialogId: randomUUID(), type: params.type as NonNullable<BrowserInteractionStateV1['dialog']>['type'], message: params.message,
                    ...(typeof params.defaultPrompt === 'string' ? { defaultPrompt: params.defaultPrompt } : {}),
                } });
            } else if (event.method === 'Page.javascriptDialogClosed' && live.state.dialog) {
                update(live, { ...live.state, dialog: null });
            } else if (event.method === 'Page.frameNavigated') {
                const frame = record(params.frame);
                if (typeof frame.id === 'string') live.frames.set(frame.id, typeof frame.parentId === 'string' ? frame.parentId : undefined);
                if (!frame.parentId && live.state.fileChooser) {
                    live.chooserNodeId = undefined;
                    update(live, { ...live.state, fileChooser: null });
                }
            } else if (event.method === 'Page.frameAttached' && typeof params.frameId === 'string') {
                live.frames.set(params.frameId, typeof params.parentFrameId === 'string' ? params.parentFrameId : undefined);
            } else if (event.method === 'Page.frameDetached' && typeof params.frameId === 'string') {
                const remove = (frameId: string) => {
                    for (const [child, parent] of live.frames) if (parent === frameId) remove(child);
                    live.frames.delete(frameId);
                };
                remove(params.frameId);
            }
        }
    };
    const unsubscribeLifecycle = input.subscribeViewLifecycle((event) => {
        const viewKey = key(event);
        if (disposed) return;
        if (event.type === 'unbound') {
            const live = views.get(viewKey);
            if (!live) return;
            views.delete(viewKey);
            notify(live);
            for (const upload of live.uploads) track(upload.dispose());
            if (views.size === 0) {
                unsubscribeEvents?.(); unsubscribeEvents = undefined;
                track(setDownloadBehavior(false));
            }
            return;
        }
        if (views.has(viewKey)) return;
        const live: LiveView = { view: { browserSessionId: event.browserSessionId, viewId: event.viewId },
            state: { dialog: null, fileChooser: null, downloads: [],
                ...(downloadSetupUnavailable && views.size > 0 ? { unavailable: { download: 'runtime_unavailable' as const } } : {}) },
            frames: new Map(), uploads: new Set() };
        views.set(viewKey, live);
        if (views.size === 1) {
            downloadSetupUnavailable = false;
            unsubscribeEvents = input.transport.subscribeCdpEvents?.(receive);
            track(setDownloadBehavior(true).catch(() => {
                downloadSetupUnavailable = true;
                for (const current of views.values()) markUnavailable(current, 'download');
            }));
        }
        if (!input.transport.subscribeCdpEvents) {
            markUnavailable(live, 'download'); markUnavailable(live, 'fileChooser');
        }
        const handle = input.resolvePageHandle(live.view);
        if (handle) {
            track(input.transport.dispatchPageCommand({ ...handle, method: 'Page.setInterceptFileChooserDialog', params: { enabled: true } })
                .catch(() => markUnavailable(live, 'fileChooser')));
            track(input.transport.dispatchPageCommand({ ...handle, method: 'Page.getFrameTree' })
                .then((tree) => { if (views.get(viewKey) === live) addFrameTree(live, record(tree).frameTree); })
                .catch(() => markUnavailable(live, 'download')));
        }
    });

    const stageUpload: BrowserSidecarInteractions['stageUpload'] = async (view, files) => {
        const live = views.get(key(view));
        if (!live || disposed) throw new Error('Browser view is closed');
        const upload = await stageBrowserUploadFiles(files);
        if (views.get(key(view)) !== live || disposed) {
            await upload.dispose();
            throw new Error('Browser view is closed');
        }
        live.uploads.add(upload);
        return upload.paths;
    };

    return {
        getState: (view) => views.get(key(view))?.state ?? null,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        stageUpload,
        async execute(request) {
            const live = views.get(key(request));
            const handle = input.resolvePageHandle(request);
            if (!live || !handle || disposed) return { ok: false, errorCode: 'view_closed' };
            if (request.signal?.aborted) return { ok: false, errorCode: 'user_canceled' };
            // Both Action and human-input callers share the canonical operand validation.
            const validation = browserAutomationInteractionPayloadSchema(request.actionKind, request.payload)?.safeParse(request.payload);
            if (!validation?.success) return { ok: false, errorCode: 'unsupported_action' };
            const payload = record(validation.data);
            if ((request.actionKind === 'download' && live.state.unavailable?.download)
                || (request.actionKind === 'upload' && live.state.unavailable?.fileChooser)) return { ok: false, errorCode: 'runtime_unavailable' };
            const scope = { ...(request.signal ? { signal: request.signal } : {}), ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}) };
            const dispatch = (method: string, params?: Record<string, unknown>) => input.transport.dispatchPageCommand({ ...handle, ...scope, method, ...(params ? { params } : {}) });
            try {
                if (request.actionKind === 'getInteractionState') return { ok: true, data: { ...live.state } };
                if (request.actionKind === 'clipboardRead' || request.actionKind === 'clipboardCut') {
                    const result = record(await dispatch('Runtime.evaluate', { expression: `${selectedTextExpression}(${request.actionKind === 'clipboardCut'})`, returnByValue: true }));
                    if (result.exceptionDetails) return { ok: false, errorCode: 'runtime_unavailable' };
                    const text = record(result.result).value;
                    return typeof text === 'string' ? { ok: true, interactionResult: { kind: 'clipboard', text } } : { ok: false, errorCode: 'runtime_unavailable' };
                }
                if (request.actionKind === 'clipboardWrite') {
                    await dispatch('Input.insertText', { text: payload.text });
                    return { ok: true };
                }
                if (request.actionKind === 'answerDialog') {
                    const dialog = live.state.dialog;
                    if (!dialog || dialog.dialogId !== payload.dialogId) return { ok: false, errorCode: 'unsupported_action' };
                    await dispatch('Page.handleJavaScriptDialog', { accept: payload.accept, ...(payload.promptText !== undefined ? { promptText: payload.promptText } : {}) });
                    if (views.get(key(request)) === live && live.state.dialog === dialog) update(live, { ...live.state, dialog: null });
                    return { ok: true };
                }
                if (request.actionKind === 'upload') {
                    const chooser = live.state.fileChooser;
                    if (!chooser || chooser.chooserId !== payload.chooserId || live.chooserNodeId === undefined) return { ok: false, errorCode: 'unsupported_action' };
                    const files = payload.files as Array<{ name: string; dataBase64: string }>;
                    const paths = await stageUpload(request, files.map((file) => ({ name: file.name, bytes: Buffer.from(file.dataBase64, 'base64') })));
                    if (views.get(key(request)) !== live) {
                        return { ok: false, errorCode: 'view_closed' };
                    }
                    await dispatch('DOM.setFileInputFiles', { files: paths, backendNodeId: live.chooserNodeId });
                    if (live.state.fileChooser === chooser) {
                        live.chooserNodeId = undefined;
                        update(live, { ...live.state, fileChooser: null });
                    }
                    return { ok: true };
                }
                if (request.actionKind === 'download') {
                    const download = live.state.downloads.find((item) => item.downloadId === payload.downloadId);
                    if (!download || download.state !== 'completed' || !directory) return { ok: false, errorCode: 'unsupported_action' };
                    const offset = payload.offset as number;
                    const file = await open(join(await directory, download.downloadId), 'r');
                    try {
                        const size = (await file.stat()).size;
                        const buffer = Buffer.alloc(Math.min(payload.byteLength as number, Math.max(0, size - offset)));
                        const { bytesRead } = buffer.length ? await file.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
                        return { ok: true, interactionResult: { kind: 'download', downloadId: download.downloadId, name: download.name,
                            offset, dataBase64: buffer.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= size } };
                    } finally { await file.close(); }
                }
                return { ok: false, errorCode: 'unsupported_action' };
            } catch {
                return { ok: false, errorCode: request.signal?.aborted ? 'user_canceled' : 'runtime_unavailable' };
            }
        },
        async dispose() {
            disposed = true;
            unsubscribeLifecycle(); unsubscribeEvents?.(); unsubscribeEvents = undefined;
            const uploads = [...views.values()].flatMap((live) => [...live.uploads]);
            const wasLive = views.size > 0;
            views.clear(); listeners.clear();
            if (wasLive) track(setDownloadBehavior(false));
            await Promise.allSettled([...work]);
            await Promise.all(uploads.map((upload) => upload.dispose()));
            // Completed bytes remain private until this connection's natural disposal boundary.
            if (directory) await rm(await directory, { recursive: true, force: true });
        },
    };
}
