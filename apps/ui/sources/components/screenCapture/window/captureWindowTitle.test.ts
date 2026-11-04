import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';
import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { captureWindowTitle } from './captureWindowTitle';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const base: NativeCaptureResult = { captureRef: 'c', kind: 'still', path: '/c.png', mimeType: 'image/png', byteSize: 1,
    pixelSize: { width: 4, height: 2 }, scale: 1, origin: null, source: null, windowTextRef: null };
const titled = (subject: string) => t('screenCapture.window.nativeTitle', { subject });

describe('Capture window native title', () => {
    it.each([
        ['a window capture names its app and window', { ...base, source: { appName: 'Safari', windowTitle: 'Fieldnote — Checkout', windowId: 7 } }, 'Safari · Fieldnote — Checkout'],
        ['a window without a title names its app', { ...base, source: { appName: 'Terminal', windowTitle: null, windowId: 7 } }, 'Terminal'],
        ['a capture with no source facts is a region', base, t('screenCapture.window.region')],
        ['a recording says so before its app', { ...base, kind: 'video', source: { appName: 'Safari', windowTitle: 'Fieldnote', windowId: 7 } }, `${t('screenCapture.recording.title')} · Safari`],
        ['a recording without an app is a recording', { ...base, kind: 'video' }, t('screenCapture.recording.title')],
    ] satisfies Array<[string, NativeCaptureResult, string]>)('%s', (_, capture, subject) => {
        expect(captureWindowTitle(capture)).toBe(titled(subject));
    });
});
