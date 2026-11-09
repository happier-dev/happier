import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const { projectCaptureShortcutRows } = await import('./ScreenCaptureSettingsSection');

const snapshot = (overrides: Partial<Parameters<typeof projectCaptureShortcutRows>[0] & object> = {}) => ({
    backend: 'native' as const, availability: 'ready' as const, configureSupported: false, editing: false,
    bindings: [
        { key: 'captureShortcut' as const, requested: 'CmdOrCtrl+Shift+2', active: 'CmdOrCtrl+Shift+2', failure: null },
        { key: 'instantWindowShortcut' as const, requested: null, active: null, failure: null },
        { key: 'recordingShortcut' as const, requested: 'CmdOrCtrl+Shift+3', active: 'CmdOrCtrl+Shift+4', failure: 'conflict' as const },
    ],
    ...overrides,
});

describe('projectCaptureShortcutRows', () => {
    it('shows the keys that work now and keeps the old binding visible beside a refusal', () => {
        const rows = projectCaptureShortcutRows(snapshot(), 'mac');
        expect(rows.captureShortcut).toMatchObject({ label: expect.stringContaining('2'), note: null, editable: true });
        expect(rows.instantWindowShortcut).toMatchObject({ label: null, note: null, editable: true });
        expect(rows.recordingShortcut).toMatchObject({ label: expect.stringContaining('4'), note: 'screenCapture.settings.conflict' });
    });

    it('explains the instant shortcut on Wayland instead of offering a recorder that cannot bind', () => {
        expect(projectCaptureShortcutRows(snapshot({ backend: 'portal' }), 'linux').instantWindowShortcut)
            .toMatchObject({ note: 'screenCapture.settings.notOnWayland', editable: false });
    });

    it('offers no recorder before the native record answers', () => {
        expect(projectCaptureShortcutRows(null, 'mac').captureShortcut).toMatchObject({ label: null, editable: false });
    });
});
