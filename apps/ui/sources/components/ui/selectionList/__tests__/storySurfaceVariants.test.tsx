import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * FR4-14 — light-coverage smoke tests for the split story-surface variant
 * modules. The existing SelectionListStorySurface integration test asserts the
 * composed surface end-to-end; these tests assert each split module renders
 * independently so a regression in any one domain is caught at file granularity.
 */

describe('SelectionListStorySurface — split variant modules (FR4-14)', () => {
    it('SelectionListBasicVariants renders all basic blocks under a root testID', async () => {
        const { SelectionListBasicVariants } = await import('../storySurface/SelectionListBasicVariants');
        const screen = await renderScreen(<SelectionListBasicVariants rootTestID="story" />);
        expect(screen.findByTestId('story:simple')).not.toBeNull();
        expect(screen.findByTestId('story:with-search')).not.toBeNull();
        expect(screen.findByTestId('story:with-steps')).not.toBeNull();
        expect(screen.findByTestId('story:with-footer')).not.toBeNull();
        expect(screen.findByTestId('story:empty')).not.toBeNull();
        expect(screen.findByTestId('story:selected-disabled')).not.toBeNull();
        expect(screen.findByTestId('story:reduced-motion')).not.toBeNull();
        expect(screen.findByTestId('story:footer-touch')).not.toBeNull();
    });

    it('SelectionListDynamicVariants renders all dynamic + slot blocks', async () => {
        const { SelectionListDynamicVariants } = await import('../storySurface/SelectionListDynamicVariants');
        const screen = await renderScreen(<SelectionListDynamicVariants rootTestID="story" />);
        expect(screen.findByTestId('story:dynamic-loading')).not.toBeNull();
        expect(screen.findByTestId('story:dynamic-error')).not.toBeNull();
        expect(screen.findByTestId('story:dynamic-empty')).not.toBeNull();
        expect(screen.findByTestId('story:dynamic-success')).not.toBeNull();
        expect(screen.findByTestId('story:value-mode-walkup')).not.toBeNull();
        expect(screen.findByTestId('story:slots-none')).not.toBeNull();
        expect(screen.findByTestId('story:slots-prefix-only')).not.toBeNull();
        expect(screen.findByTestId('story:slots-suffix-only')).not.toBeNull();
        expect(screen.findByTestId('story:slots-both')).not.toBeNull();
    });

    it('SelectionListPathVariants renders all path-picker hosts', async () => {
        const { SelectionListPathVariants } = await import('../storySurface/SelectionListPathVariants');
        const screen = await renderScreen(<SelectionListPathVariants rootTestID="story" />);
        expect(screen.findByTestId('story:path-real-success')).not.toBeNull();
        expect(screen.findByTestId('story:path-real-loading')).not.toBeNull();
        expect(screen.findByTestId('story:path-real-error')).not.toBeNull();
    });

    it('SelectionListWorktreeVariants renders the worktree picker block', async () => {
        const { SelectionListWorktreeVariants } = await import('../storySurface/SelectionListWorktreeVariants');
        const screen = await renderScreen(<SelectionListWorktreeVariants rootTestID="story" />);
        expect(screen.findByTestId('story:worktree-real')).not.toBeNull();
    });

    it('SelectionListTransitionVariants renders the transition stress block', async () => {
        const { SelectionListTransitionVariants } = await import('../storySurface/SelectionListTransitionVariants');
        const screen = await renderScreen(<SelectionListTransitionVariants rootTestID="story" />);
        expect(screen.findByTestId('story:transition-stress')).not.toBeNull();
    });
});
