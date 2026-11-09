import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// The popover's portal and window measurement render inline; the real menu triggers stay.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

import { SessionTerminalStrip, SESSION_TERMINAL_STRIP_METRICS as S } from './SessionTerminalStrip';

const noop = () => {};
const DRAWN = { width: S.actionSizePx, height: S.actionSizePx };

async function renderStrip() {
    return renderScreen(
        <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <SessionTerminalStrip
                tabs={[]} activeTabId={null} listShowing activeTerminal={null}
                onActivateTab={noop} onCloseTab={noop} onTabMenu={noop} onNewShell={noop}
                newMenuOpen={false} onNewMenuOpenChange={noop} newMenuItems={[]} onNewMenuSelect={noop}
                canSplit onSplit={noop} paneMenuItems={[]} onPaneMenuSelect={noop} onHide={noop} onOpenUrl={noop}
            />
        </HappierUiPlatformProvider>,
    );
}

describe('SessionTerminalStrip hit areas', () => {
    // 28 px actions sit 2 px apart (12 px across the separator): unbounded, each reaches 8 px sideways.
    it('splits each real gap between neighbouring actions and keeps New out of its dropdown chevron', async () => {
        const screen = await renderStrip();
        const area = (id: string) => readHitArea(screen.findByTestId(`terminal-strip-${id}`)!, DRAWN);
        const split = area('split');
        const more = area('more');
        const hide = area('hide');
        expect(hitAreaOverlap(split, more, { axis: 'horizontal', gap: 2 })).toBe(0);
        expect(hitAreaOverlap(more, hide, { axis: 'horizontal', gap: 2 + 4 + 4 + 2 })).toBe(0);
        // The chevron abuts New at gap 0 and has no reach of its own: New must not enter it.
        expect(area('new').insets.right).toBe(0);
    });
});
