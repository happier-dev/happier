import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const updateStatusState = vi.hoisted(() => ({
    visible: false,
}));

vi.mock('@/updates/useAppUpdateStatus', () => ({
    useAppUpdateStatus: () => ({
        model: updateStatusState.visible
            ? {
                visible: true,
                kind: 'ota',
                tone: 'accent',
                iconName: 'download-outline',
                label: 'Update available',
                message: 'Press to apply the update',
                actionLabel: 'Press to apply the update',
                actionDisabled: false,
            }
            : { visible: false },
        runPrimaryAction: vi.fn(async () => {}),
        dismiss: vi.fn(),
    }),
}));

vi.mock('@/components/ui/feedback/AppUpdateStatusPopover', () => ({
    AppUpdateStatusPopover: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key === 'updateBanner.updateShort' ? 'Update' : key,
}));

describe('AppUpdateStatusTag', () => {
    afterEach(() => {
        updateStatusState.visible = false;
        standardCleanup();
    });

    it('renders the fallback slot when no update status is visible', async () => {
        const { AppUpdateStatusTag } = await import('./AppUpdateStatusTag');

        const screen = await renderScreen(
            <AppUpdateStatusTag fallback={React.createElement('FallbackSlot')} />,
        );

        expect(screen.findByType('FallbackSlot' as never)).toBeTruthy();
    });

    it('can render a compact chrome label for constrained header slots', async () => {
        updateStatusState.visible = true;
        const { AppUpdateStatusTag } = await import('./AppUpdateStatusTag');

        const screen = await renderScreen(
            <AppUpdateStatusTag labelVariant="short" testID="compact-update-tag" />,
        );

        expect(screen.findByProps({ children: 'Update' })).toBeTruthy();
    });
});
