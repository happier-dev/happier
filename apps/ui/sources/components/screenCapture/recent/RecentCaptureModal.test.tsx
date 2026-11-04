import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { Modal } from '@/modal';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { readSessionAttachmentDrafts, resolveSessionAttachmentDraftScope, sessionAttachmentDraftKey,
    clearSessionAttachmentDrafts } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import type { NativeRecentCaptureEntry } from '@/desktop/capture/nativeCapture';
import { showRecentCaptureModal } from './RecentCaptureModal';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const target = { serverId: 'capture-home', accountId: 'alice', sessionId: 'composer', machineId: 'machine' };
const attachmentScope = resolveSessionAttachmentDraftScope(target);
const otherScope = resolveSessionAttachmentDraftScope({ ...target, sessionId: 'other-composer' });
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

afterEach(() => {
    clearSessionAttachmentDrafts(attachmentScope);
    clearSessionAttachmentDrafts(otherScope);
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

function readPickerSelection(): (entry: NativeRecentCaptureEntry) => void | Promise<void> {
    // Modal presentation is the system boundary; its real selection callback stays intact.
    const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    const props = config?.props as Readonly<{ onChoose: (entry: NativeRecentCaptureEntry) => void | Promise<void> }>;
    return props.onChoose;
}

function installRecentFileBoundary(payload = bytes) {
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
        if (command === 'desktop_capture_recent_read') return payload.buffer;
        // Hold the incorrect editor-opening path at native admission: no editor should be opened.
        return new Promise<never>(() => {});
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    return invoke;
}

it.each([
    { name: 'Screenshot.png', kind: 'still' as const, mimeType: 'image/png', payload: bytes },
    { name: 'Recording.mov', kind: 'video' as const, mimeType: 'video/quicktime', payload: new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 113, 116, 32, 32]) },
])('attaches recent $name to the captured composer tray as a picked file without opening Capture', async ({ name, kind, mimeType, payload }) => {
    const invoke = installRecentFileBoundary(payload);
    const picked = vi.fn();
    const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
        memoryKey: sessionAttachmentDraftKey(attachmentScope), onPickedDrafts: picked }));
    try {
        showRecentCaptureModal(hook.getCurrent().addPickedAttachments);
        expect(invoke).not.toHaveBeenCalled();
        await act(async () => { await readPickerSelection()({ path: `/captures/${name}`, name, kind,
            byteSize: payload.byteLength, modifiedAt: null, modifiedAtNanos: null }); });
        expect(invoke.mock.calls).toEqual([['desktop_capture_recent_read', { path: `/captures/${name}` }]]);
        const drafts = readSessionAttachmentDrafts(attachmentScope);
        expect(drafts).toHaveLength(1);
        expect(drafts[0]?.source.kind).toBe('web');
        if (drafts[0]?.source.kind !== 'web') throw new Error('Expected ordinary picked-file intake');
        expect(drafts[0].source.file).toMatchObject({ name, type: mimeType, size: payload.byteLength });
        expect(new Uint8Array(await drafts[0].source.file.arrayBuffer())).toEqual(payload);
        expect(hook.getCurrent().agentInputAttachments).toEqual([expect.objectContaining({ label: name })]);
        expect(picked.mock.calls).toEqual([[drafts]]);
        expect(readSessionAttachmentDrafts(otherScope)).toEqual([]);
    } finally { await hook.unmount(); }
});

it('does not redirect a recent pick into another composer after its captured intake has left', async () => {
    installRecentFileBoundary();
    let scope = attachmentScope;
    const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
        memoryKey: sessionAttachmentDraftKey(scope) }));
    try {
        showRecentCaptureModal(hook.getCurrent().addPickedAttachments);
        const choose = readPickerSelection();
        scope = otherScope;
        await hook.rerender();
        await act(async () => { await choose({ path: '/captures/Screenshot.png', name: 'Screenshot.png', kind: 'still',
            byteSize: bytes.byteLength, modifiedAt: null, modifiedAtNanos: null }); });
        expect(readSessionAttachmentDrafts(attachmentScope)).toEqual([]);
        expect(readSessionAttachmentDrafts(otherScope)).toEqual([]);
    } finally { await hook.unmount(); }
});
