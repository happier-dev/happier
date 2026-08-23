import { afterEach, describe, expect, it, vi } from 'vitest';

import { isDesktopMainWindowFocused, isDesktopMainWindowVisible } from './desktopMainWindowPresence';

const isDesktopHostMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostMock(),
}));

type DocumentStub = Readonly<{
    visibilityState?: string;
    hasFocus?: () => boolean;
}>;

function setDocument(doc: DocumentStub | undefined): void {
    const globals = globalThis as Partial<{ document: unknown }>;
    if (doc === undefined) {
        delete globals.document;
        return;
    }
    Object.defineProperty(globalThis, 'document', {
        value: doc,
        configurable: true,
        writable: true,
    });
}

describe('desktop main window presence', () => {
    const originalDocument = (globalThis as Partial<{ document: unknown }>).document;

    afterEach(() => {
        isDesktopHostMock.mockReset();
        isDesktopHostMock.mockReturnValue(true);
        setDocument(originalDocument as DocumentStub | undefined);
    });

    describe('isDesktopMainWindowVisible', () => {
        it('keeps a visible window present while another app holds focus', () => {
            setDocument({ visibilityState: 'visible', hasFocus: () => false });

            expect(isDesktopMainWindowVisible()).toBe(true);
        });

        it('reports a hidden, unfocused window as absent', () => {
            setDocument({ visibilityState: 'hidden', hasFocus: () => false });

            expect(isDesktopMainWindowVisible()).toBe(false);
        });

        it('escapes a visibilityState wedged at hidden when the document reports focus', () => {
            // A focused document cannot be hidden. macOS can strand a webview at
            // 'hidden' with no further visibilitychange, and without this escape
            // the window would never be present again for the rest of the process.
            setDocument({ visibilityState: 'hidden', hasFocus: () => true });

            expect(isDesktopMainWindowVisible()).toBe(true);
        });

        it('survives a host whose hasFocus throws while wedged at hidden', () => {
            setDocument({
                visibilityState: 'hidden',
                hasFocus: () => {
                    throw new Error('detached webview');
                },
            });

            expect(isDesktopMainWindowVisible()).toBe(false);
        });

        it('is false off a desktop host even when the document looks visible', () => {
            isDesktopHostMock.mockReturnValue(false);
            setDocument({ visibilityState: 'visible', hasFocus: () => true });

            expect(isDesktopMainWindowVisible()).toBe(false);
        });
    });

    describe('isDesktopMainWindowFocused', () => {
        it('is false for a visible window the user is not interacting with', () => {
            // The separation that matters: this window is present enough to
            // describe, and not present enough to swallow a notification.
            setDocument({ visibilityState: 'visible', hasFocus: () => false });

            expect(isDesktopMainWindowVisible()).toBe(true);
            expect(isDesktopMainWindowFocused()).toBe(false);
        });

        it('is true for a focused window', () => {
            setDocument({ visibilityState: 'visible', hasFocus: () => true });

            expect(isDesktopMainWindowFocused()).toBe(true);
        });

        it('falls back to visibility on a host that publishes no hasFocus', () => {
            setDocument({ visibilityState: 'visible' });
            expect(isDesktopMainWindowFocused()).toBe(true);

            setDocument({ visibilityState: 'hidden' });
            expect(isDesktopMainWindowFocused()).toBe(false);
        });

        it('is false off a desktop host', () => {
            isDesktopHostMock.mockReturnValue(false);
            setDocument({ visibilityState: 'visible', hasFocus: () => true });

            expect(isDesktopMainWindowFocused()).toBe(false);
        });
    });
});
