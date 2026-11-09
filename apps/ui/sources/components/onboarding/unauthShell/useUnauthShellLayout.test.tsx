import * as React from 'react';
import { Text, useWindowDimensions } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { onboardingHistoryState } from '@/sync/domains/state/onboardingUiState';

import { useUnauthShellLayout } from './useUnauthShellLayout';

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        useWindowDimensions: vi.fn(),
    };
});

function setup(width: number, brandHeroSeenAt: number | null) {
    (useWindowDimensions as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        width,
        height: 800,
        scale: 1,
        fontScale: 1,
    });
    onboardingHistoryState.set('brandHeroSeenAt', brandHeroSeenAt);
}

function Probe({ allow }: { allow: boolean }) {
    const layout = useUnauthShellLayout({ allowMobileBrandHero: allow });
    return <Text testID="layout-probe">{layout}</Text>;
}

describe('useUnauthShellLayout', () => {
    const initialState = storage.getState();
    afterEach(() => {
        storage.setState(initialState, true);
    });

    it('returns "split" on desktop widths', async () => {
        setup(1100, null);
        const screen = await renderScreen(<Probe allow />);
        expect(screen.findByTestId('layout-probe')?.children).toEqual(['split']);
    });

    it('returns "mobile-hero" on mobile when brand hero is allowed and unseen', async () => {
        setup(393, null);
        const screen = await renderScreen(<Probe allow />);
        expect(screen.findByTestId('layout-probe')?.children).toEqual(['mobile-hero']);
    });

    it('returns "mobile-workflow" on mobile when brand hero is allowed but already seen', async () => {
        setup(393, 1_700_000_000_000);
        const screen = await renderScreen(<Probe allow />);
        expect(screen.findByTestId('layout-probe')?.children).toEqual(['mobile-workflow']);
    });

    it('returns "mobile-workflow" on mobile when brand hero is not allowed for this route', async () => {
        setup(393, null);
        const screen = await renderScreen(<Probe allow={false} />);
        expect(screen.findByTestId('layout-probe')?.children).toEqual(['mobile-workflow']);
    });

    it('treats 720px as the inclusive mobile threshold', async () => {
        setup(720, null);
        let screen = await renderScreen(<Probe allow />);
        expect(screen.findByTestId('layout-probe')?.children).toEqual(['mobile-hero']);

        setup(721, null);
        screen = await renderScreen(<Probe allow />);
        expect(screen.findByTestId('layout-probe')?.children).toEqual(['split']);
    });
});
