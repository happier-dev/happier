import * as React from 'react';
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
// The platform clipboard is the only action boundary; the file menu and list stay real.
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('expo-clipboard', () => clipboard);

describe('diff stream file actions', () => {
    it('offers Copy path even when a read-only stash has no open or write callback', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        const screen = await renderScreen(<OverlayPortalProvider>
            <DiffFilesListView files={[{
                key: 'settings', filePath: 'src/settings.ts', added: 2, removed: 1,
                unifiedDiff: '',
            }]} expandedKeys={new Set()} onToggleExpanded={() => {}} canRenderInlineDiffs={false}
                wrapLines showLineNumbers showPrefix />
            <OverlayPortalHost />
        </OverlayPortalProvider>, {
            // Platform view measurement supplies the real anchored menu's host geometry.
            createNodeMock: () => ({ measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(0, 0, 600, 40) }),
        });
        await screen.pressByTestIdAsync('diff-file-menu:src/settings.ts');
        await flushHookEffects({ cycles: 3, turns: 4 });
        await screen.pressByTestIdAsync('diff-file-copy-path');
        await flushHookEffects({ cycles: 2, turns: 4 });
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('src/settings.ts');
    });
});
