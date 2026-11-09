import { afterEach, expect, it, vi } from 'vitest';
import { createScreenCaptureAttachmentActions } from './screenCaptureAttachmentActions';
import { ScreenCaptureStartInputSchema } from '@happier-dev/protocol/actions/actionSpecs';

afterEach(() => vi.unstubAllGlobals());
it('keeps all desktop entries on the captured composer Session and starts no native reads', async () => {
    const native = vi.fn();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: native });
    const execute = vi.fn<Parameters<typeof createScreenCaptureAttachmentActions>[0]['execute']>(async () => ({ ok: true, result: {} }));
    const openRecent = vi.fn();
    const targetSession = { serverId: 'home', accountId: 'account', sessionId: 'composer-session' };
    const entries = createScreenCaptureAttachmentActions({ targetSession, execute, openRecent });
    expect(entries.map(entry => entry.id)).toEqual(['capture-screen', 'record-screen', 'attach-recent-capture']);
    expect(native).not.toHaveBeenCalled();
    for (const entry of entries) await entry.run();
    expect(execute.mock.calls).toEqual([
        ['screenCapture.start', { mode: 'screenshot', targetSession }],
        ['screenCapture.start', { mode: 'recording', targetSession }],
    ]);
    for (const [, value] of execute.mock.calls) expect(ScreenCaptureStartInputSchema.safeParse(value).success).toBe(true);
    expect(openRecent).toHaveBeenCalledWith(targetSession);
});
it('offers no global capture entries in browsers or Electron', () => {
    const input = { targetSession: { serverId: 'home', accountId: 'account', sessionId: 'session' },
        execute: vi.fn(), openRecent: vi.fn() };
    expect(createScreenCaptureAttachmentActions(input)).toEqual([]);
    vi.stubGlobal('navigator', { userAgent: 'Electron/40' });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
    expect(createScreenCaptureAttachmentActions(input)).toEqual([]);
});
