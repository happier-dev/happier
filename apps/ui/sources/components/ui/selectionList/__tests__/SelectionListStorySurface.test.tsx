import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListStorySurface', () => {
    it('renders all configured variant blocks under a single root testID', async () => {
        const { SelectionListStorySurface } = await import('../SelectionListStorySurface');
        const screen = await renderScreen(
            <SelectionListStorySurface testID="story" />,
        );
        expect(screen.findByTestId('story')).not.toBeNull();
        expect(screen.findByTestId('story:simple')).not.toBeNull();
        expect(screen.findByTestId('story:with-search')).not.toBeNull();
        expect(screen.findByTestId('story:with-steps')).not.toBeNull();
        expect(screen.findByTestId('story:with-footer')).not.toBeNull();
        expect(screen.findByTestId('story:empty')).not.toBeNull();
        expect(screen.findByTestId('story:selected-disabled')).not.toBeNull();
        expect(screen.findByTestId('story:reduced-motion')).not.toBeNull();
    });

    it('renders inner SelectionList instances with their own roots', async () => {
        const { SelectionListStorySurface } = await import('../SelectionListStorySurface');
        const screen = await renderScreen(
            <SelectionListStorySurface testID="story" />,
        );
        // The simple list contains the "plan" option.
        expect(screen.findByTestId('story-simple-list:simple:option:plan')).not.toBeNull();
        // The selected-disabled list marks "plan" as selected (we just assert the row exists).
        expect(
            screen.findByTestId('story-selected-disabled-list:selected-disabled:option:windows-only'),
        ).not.toBeNull();
    });

    it('renders the with-search status pills (clean, dirty count)', async () => {
        const { SelectionListStorySurface } = await import('../SelectionListStorySurface');
        const screen = await renderScreen(
            <SelectionListStorySurface testID="story" />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('clean');
        expect(text).toContain('ch');
    });

    it('R6 Fix 6: renders real-composition variants (path picker + worktree + transition stress)', async () => {
        const { SelectionListStorySurface } = await import('../SelectionListStorySurface');
        const screen = await renderScreen(
            <SelectionListStorySurface testID="story" />,
        );
        expect(screen.findByTestId('story:path-real-success')).not.toBeNull();
        expect(screen.findByTestId('story:path-real-loading')).not.toBeNull();
        expect(screen.findByTestId('story:path-real-error')).not.toBeNull();
        expect(screen.findByTestId('story:worktree-real')).not.toBeNull();
        expect(screen.findByTestId('story:transition-stress')).not.toBeNull();
    });

    it('Phase 2.8: renders dynamic-section variants (loading / error / empty / success) and slot variants', async () => {
        const { SelectionListStorySurface } = await import('../SelectionListStorySurface');
        const screen = await renderScreen(
            <SelectionListStorySurface testID="story" />,
        );
        expect(screen.findByTestId('story:dynamic-loading')).not.toBeNull();
        expect(screen.findByTestId('story:dynamic-error')).not.toBeNull();
        expect(screen.findByTestId('story:dynamic-empty')).not.toBeNull();
        expect(screen.findByTestId('story:dynamic-success')).not.toBeNull();
        expect(screen.findByTestId('story:value-mode-walkup')).not.toBeNull();
        expect(screen.findByTestId('story:footer-touch')).not.toBeNull();
        expect(screen.findByTestId('story:slots-none')).not.toBeNull();
        expect(screen.findByTestId('story:slots-prefix-only')).not.toBeNull();
        expect(screen.findByTestId('story:slots-suffix-only')).not.toBeNull();
        expect(screen.findByTestId('story:slots-both')).not.toBeNull();
    });
});
