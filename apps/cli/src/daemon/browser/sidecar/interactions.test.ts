import { PassThrough } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BrowserInteractionStateV1Schema } from '@happier-dev/protocol';
import { createBrowserSidecarCdpControlAdapterFactory } from './controlAdapterFactory';
import type { BrowserSidecarCdpEventSubscriber } from './controlAdapter';

describe('managed browser human interactions', () => {
  it('cuts only an editable unmasked selection and retains the surrounding value', async () => {
    const field = { type: 'text', tagName: 'INPUT', value: 'before selected after', selectionStart: 7, selectionEnd: 15,
      closest: () => null, masked: false, readOnly: false, disabled: false };
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
      pipe: { readable: new PassThrough(), writable: new PassThrough() },
      connectTransport: async () => ({ transport: {
        openPage: async () => ({ targetId: 'target', sessionId: 'page' }), dispatchBrowserCommand: async () => ({}),
        dispatchPageCommand: async command => command.method === 'Runtime.evaluate' ? { result: { value: runInNewContext(String(command.params?.expression), {
          document: { activeElement: field, execCommand: (command: string) => {
            if (command !== 'delete') throw new Error('unexpected edit');
            field.value = field.value.slice(0, field.selectionStart) + field.value.slice(field.selectionEnd); return true;
          } }, window: { getSelection: () => null }, getComputedStyle: () => ({ webkitTextSecurity: field.masked ? 'disc' : 'none' }),
        }) } } : {},
      } }),
    });
    const result = await factory({ machineId: 'machine' });
    if (!result.ok) throw new Error('browser unavailable');
    try {
      const view = { browserSessionId: 'browser', viewId: 'view' };
      await result.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
      const cut = () => result.contextCapture?.interactions?.execute({ ...view, actionKind: 'clipboardCut', payload: {} });
      for (const protection of ['password', 'masked', 'readOnly', 'disabled'] as const) {
        field.type = protection === 'password' ? 'password' : 'text'; field.masked = protection === 'masked';
        field.readOnly = protection === 'readOnly'; field.disabled = protection === 'disabled';
        expect(await cut()).toMatchObject({ ok: true, interactionResult: { text: protection === 'password' || protection === 'masked' ? '' : 'selected' } });
        expect(field.value).toBe('before selected after');
      }
      field.disabled = false;
      expect(await cut()).toMatchObject({ ok: true, interactionResult: { text: 'selected' } });
      expect(field.value).toBe('before  after');
    } finally { await result.dispose?.(); }
  });
  it('publishes setup failures as unavailable instead of silently advertising dead capabilities', async () => {
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
      pipe: { readable: new PassThrough(), writable: new PassThrough() },
      connectTransport: async () => ({ transport: {
        openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
        dispatchPageCommand: async (command) => {
          if (command.method === 'Page.setInterceptFileChooserDialog') throw new Error('CDP setup refused');
          return {};
        },
        dispatchBrowserCommand: async (command) => {
          if (command.method === 'Browser.setDownloadBehavior' && command.params?.behavior !== 'default') throw new Error('CDP setup refused');
          return {};
        },
        subscribeCdpEvents: () => () => {},
      } }),
    });
    const result = await factory({ machineId: 'machine' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      const view = { browserSessionId: 'browser', viewId: 'view' };
      await result.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
      const owner = result.contextCapture?.interactions;
      await vi.waitFor(() => expect(owner?.getState(view)).toMatchObject({ unavailable: {
        fileChooser: 'runtime_unavailable', download: 'runtime_unavailable',
      } }));
      expect(await owner?.execute({ ...view, actionKind: 'download', payload: { downloadId: 'download', offset: 0, byteLength: 1 } }))
        .toEqual({ ok: false, errorCode: 'runtime_unavailable' });
      expect(await owner?.execute({ ...view, actionKind: 'upload', payload: { chooserId: 'chooser', files: [] } }))
        .toEqual({ ok: false, errorCode: 'runtime_unavailable' });
    } finally { await result.dispose?.(); }
  });
  it('suppresses password and CSS masked selections without reading their values, including masked range interiors', async () => {
    const input = { type: 'text', tagName: 'INPUT', selectionStart: 0, selectionEnd: 6,
      nodeType: 1, closest: () => null, masked: false };
    const value = vi.fn(() => 'secret');
    Object.defineProperty(input, 'value', { get: value });
    const masked = { nodeType: 1, closest: () => null, masked: true, children: [] };
    const safe = { nodeType: 1, closest: () => null, masked: false, children: [] };
    const root = { nodeType: 1, closest: () => null, masked: false, children: [safe, masked, safe] };
    let active: unknown = input;
    let selection: unknown = null;
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
      pipe: { readable: new PassThrough(), writable: new PassThrough() },
      connectTransport: async () => ({ transport: {
        openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
        dispatchBrowserCommand: async () => ({}),
        dispatchPageCommand: async (command) => command.method === 'Runtime.evaluate'
          ? { result: { value: runInNewContext(String(command.params?.expression), {
            document: { activeElement: active }, window: { getSelection: () => selection }, Node: { ELEMENT_NODE: 1 },
            getComputedStyle: (element: { masked: boolean }) => ({ webkitTextSecurity: element.masked ? 'disc' : 'none' }),
          }) } } : {},
      } }),
    });
    const result = await factory({ machineId: 'machine' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      const view = { browserSessionId: 'browser', viewId: 'view' };
      await result.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
      const read = () => result.contextCapture?.interactions?.execute({ ...view, actionKind: 'clipboardRead', payload: {} });
      input.type = 'password';
      expect(await read()).toMatchObject({ ok: true, interactionResult: { text: '' } });
      input.type = 'text'; input.masked = true;
      expect(await read()).toMatchObject({ ok: true, interactionResult: { text: '' } });
      expect(value).not.toHaveBeenCalled();
      input.masked = false;
      expect(await read()).toMatchObject({ ok: true, interactionResult: { text: 'secret' } });
      active = null;
      selection = { anchorNode: safe, focusNode: safe, rangeCount: 1,
        getRangeAt: () => ({ commonAncestorContainer: root, intersectsNode: () => true }), toString: () => 'public secret public' };
      expect(await read()).toMatchObject({ ok: true, interactionResult: { text: '' } });
      selection = { anchorNode: safe, focusNode: safe, rangeCount: 1,
        getRangeAt: () => ({ commonAncestorContainer: root, intersectsNode: (element: unknown) => element !== masked }), toString: () => 'public' };
      expect(await read()).toMatchObject({ ok: true, interactionResult: { text: 'public' } });
    } finally { await result.dispose?.(); }
  });
  it('relays chooser bytes, dialog answers, selected clipboard text and download ranges through the live view only', async () => {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: Array<{ method: string; sessionId?: string; params?: Record<string, unknown> }> = [];
    let downloadPath = '';
    let uploaded = Buffer.alloc(0);
    const transport = {
      openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
      async dispatchPageCommand(command: (typeof commands)[number]) {
        commands.push(command);
        if (command.method === 'DOM.setFileInputFiles') {
          const files = command.params?.files;
          if (Array.isArray(files) && typeof files[0] === 'string') uploaded = await readFile(files[0]);
        }
        if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'https://example.test/' } } };
        if (command.method === 'Runtime.evaluate') return { result: { value: 'selected text' } };
        return {};
      },
      async dispatchBrowserCommand(command: (typeof commands)[number]) {
        commands.push(command);
        if (command.method === 'Browser.setDownloadBehavior') downloadPath = String(command.params?.downloadPath);
        return { success: true };
      },
      subscribeCdpEvents(listener: BrowserSidecarCdpEventSubscriber) {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
    };
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
      pipe: { readable: new PassThrough(), writable: new PassThrough() },
      connectTransport: async () => ({ transport }),
    });
    const result = await factory({ machineId: 'machine' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      const owner = result.contextCapture?.interactions;
      expect(owner).toBeDefined();
      if (!owner) return;
      expect(listeners.size).toBe(0);
      const view = { browserSessionId: 'browser', viewId: 'view' };
      await result.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
      await vi.waitFor(() => expect(downloadPath).not.toBe(''));
      const emit = (method: string, params: Record<string, unknown>, sessionId = 'page') => {
        for (const listener of [...listeners]) listener({ method, params, sessionId });
      };
      emit('Page.fileChooserOpened', { backendNodeId: 44, mode: 'selectSingle' }, 'another-page');
      expect(owner.getState(view)?.fileChooser).toBeNull();
      emit('Page.fileChooserOpened', { backendNodeId: 44, mode: 'selectSingle' });
      const chooserId = owner.getState(view)?.fileChooser?.chooserId;
      expect(chooserId).toEqual(expect.any(String));
      expect(await owner.execute({ ...view, actionKind: 'upload', payload: { chooserId,
        files: [{ name: 'binary.dat', dataBase64: 'AP+A' }] } })).toMatchObject({ ok: true });
      expect(uploaded).toEqual(Buffer.from([0, 255, 128]));
      expect(owner.getState(view)?.fileChooser).toBeNull();
      expect(await owner.execute({ ...view, actionKind: 'upload', payload: { chooserId, files: [] } }))
        .toMatchObject({ ok: false });
      emit('Page.fileChooserOpened', { backendNodeId: 45, mode: 'selectSingle' });
      const previousChooser = owner.getState(view)?.fileChooser?.chooserId;
      emit('Page.frameNavigated', { frame: { id: 'frame', url: 'https://example.test/next' } });
      expect(owner.getState(view)?.fileChooser).toBeNull();
      expect(await owner.execute({ ...view, actionKind: 'upload', payload: { chooserId: previousChooser, files: [] } }))
        .toMatchObject({ ok: false });
      emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Your name?', defaultPrompt: 'guest' });
      const dialogId = owner.getState(view)?.dialog?.dialogId;
      expect(await owner.execute({ ...view, actionKind: 'answerDialog', payload: { dialogId, accept: true, promptText: 'Alice' } }))
        .toMatchObject({ ok: true });
      expect(commands).toContainEqual(expect.objectContaining({ method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Alice' } }));
      expect(await owner.execute({ ...view, actionKind: 'clipboardRead', payload: {} }))
        .toMatchObject({ ok: true, interactionResult: { kind: 'clipboard', text: 'selected text' } });
      expect(await owner.execute({ ...view, actionKind: 'clipboardWrite', payload: { text: 'paste' } })).toMatchObject({ ok: true });
      const changed = vi.fn();
      const unsubscribe = owner.subscribe(changed);
      emit('Browser.downloadWillBegin', { frameId: 'unknown', guid: 'ignored', suggestedFilename: 'private' });
      emit('Browser.downloadWillBegin', { frameId: 'frame', guid: '../private', suggestedFilename: 'private' });
      expect(changed).not.toHaveBeenCalled();
      for (const listener of [...listeners]) listener({ method: 'Browser.downloadWillBegin', params: { frameId: 'frame', guid: 'download', suggestedFilename: 'report.bin' } });
      await writeFile(join(downloadPath, 'download'), Buffer.from([0, 255, 128, 65]));
      emit('Browser.downloadProgress', { guid: 'download', state: 'completed', receivedBytes: 4, totalBytes: 4 });
      emit('Browser.downloadProgress', { guid: 'download', state: 'completed', receivedBytes: 4, totalBytes: 4 });
      expect(changed).toHaveBeenCalledTimes(2);
      unsubscribe();
      expect(await owner.execute({ ...view, actionKind: 'download', payload: { downloadId: 'download', offset: 1, byteLength: 2 } }))
        .toMatchObject({ ok: true, interactionResult: { kind: 'download', dataBase64: '/4A=', eof: false, offset: 1 } });
      expect(await owner.execute({ ...view, actionKind: 'download', payload: { downloadId: '../private', offset: 0, byteLength: 4 } }))
        .toMatchObject({ ok: false });
      expect(BrowserInteractionStateV1Schema.safeParse(owner.getState(view)).success).toBe(true);
      await result.adapter.dispatchCommand({ ...view, kind: 'closeView', commandId: 'close' });
      expect(listeners.size).toBe(0);
      expect(owner.getState(view)).toBeNull();
      expect(commands).toContainEqual(expect.objectContaining({ method: 'Browser.setDownloadBehavior', params: { behavior: 'default', eventsEnabled: false } }));
      const count = commands.length;
      emit('Page.javascriptDialogOpening', { type: 'alert', message: 'stale' });
      expect(commands).toHaveLength(count);
    } finally { await result.dispose?.(); }
  });
});
