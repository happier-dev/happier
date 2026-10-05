import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
// Clipboard is a platform boundary; the header and overflow remain real.
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('expo-clipboard', () => clipboard);

describe('commit Details actions', () => {
    it('copies the full commit identity from its read-only overflow', async () => {
        const { ScmCommitDetailsHeader } = await import('./ScmCommitDetailsHeader');
        const screen = await renderScreen(<OverlayPortalProvider>
            <ScmCommitDetailsHeader sha="abcdef1234567890" commit={{ status: 'unavailable', entry: null }} />
            <OverlayPortalHost />
        </OverlayPortalProvider>, {
            createNodeMock: () => ({ measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(0, 0, 600, 40) }),
        });
        await screen.pressByTestIdAsync('scm-commit-details-header.menu.trigger');
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
        await flushHookEffects({ cycles: 3, turns: 4 });
        await screen.pressByTestIdAsync('scm-commit-details-menu-copy-sha');
        await act(async () => { await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith('abcdef1234567890')); });
    });
});
