import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { STILL_WAITING_AFTER_MS } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { AppBootPendingSurface } from './AppBootPendingSurface';

const host = vi.hoisted(() => ({ desktop: true }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock({ View: 'View' });
});

// The native shell boundary: whether a desktop shell hosts this renderer.
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const { createDesktopHostModuleMock } = await import('@/dev/testkit/mocks/desktopHost');
    return createDesktopHostModuleMock({ importOriginal, overrides: { isDesktopHost: () => host.desktop } });
});

function renderedText(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    return JSON.stringify(screen.tree.toJSON());
}

describe('app boot pending surface', () => {
    afterEach(() => {
        host.desktop = true;
        standardCleanup();
    });

    it('stays blank through an ordinary credential read and explains a held one once the shared wait threshold passes', async () => {
        vi.useFakeTimers();
        try {
            const screen = await renderScreen(<AppBootPendingSurface phase="credentials" />);
            // A signed-in boot spends ~0.1-0.2 s here: it must never flash.
            await act(async () => { vi.advanceTimersByTime(STILL_WAITING_AFTER_MS - 1_000); });
            expect(screen.tree.toJSON()).toBeNull();

            // A keychain prompt holds the read: say what the app is waiting for.
            await act(async () => { vi.advanceTimersByTime(1_000); });
            expect(screen.tree.root.findAll((node) => node.props.testID === 'app-boot-credential-access').length).toBeGreaterThan(0);
            expect(renderedText(screen)).toContain(t('appBoot.credentialAccessTitle'));
        } finally {
            vi.useRealTimers();
        }
    });

    it('stays blank in every other boot phase and in a browser', async () => {
        for (const phase of [null, 'session-drafts', 'crypto', 'translations', 'ready'] as const) {
            const screen = await renderScreen(<AppBootPendingSurface phase={phase} />);
            expect(screen.tree.toJSON()).toBeNull();
        }
        host.desktop = false;
        const browser = await renderScreen(<AppBootPendingSurface phase="credentials" />);
        expect(browser.tree.toJSON()).toBeNull();
    });
});
