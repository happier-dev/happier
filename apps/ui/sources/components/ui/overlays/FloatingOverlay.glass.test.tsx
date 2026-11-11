import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { FloatingOverlay } from './FloatingOverlay';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View: 'View' }));

afterEach(() => standardCleanup());

// Owner 2026-11-11 (OWNER-1330-COAT/03): anchored popovers kept the dialogs' near-opaque coat next to the new card
// glass. Every anchored popover is glass like a menu (the tint's hair, solved against the picture); only dialogs,
// sheets and live pictures carry a panel coat.
describe('anchored popover glass', () => {
    it('asks its glass for the menu material, never the panel coat (large anchored panels included)', async () => {
        const screen = await renderScreen(<FloatingOverlay maxHeight={400}><></></FloatingOverlay>);
        const glass = screen.findAll((node) => node.props?.surfaceGroup === 'floating');
        expect(glass.length).toBeGreaterThan(0);
        for (const node of glass) expect(node.props.floatingRole).not.toBe('panel');
    });
});
