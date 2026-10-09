import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        addEventListener: () => ({ remove: () => {} }) } });
} });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 }))));
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

describe('Add Home phone path selection', () => {
    it('names its choice group through the shared ItemGroup owner', async () => {
        const { HomeAddForm } = await import('./HomeAddForm');
        const screen = await renderScreen(<HomeAddForm layout="page" testID="add-home" onClose={() => {}} />);
        const group = screen.findAllByType('View' as never).find(node =>
            node.props.role === 'radiogroup' || node.props.accessibilityRole === 'radiogroup');
        expect(group).toBeDefined();
        expect(group?.props.accessibilityLabel).toBeTruthy();
        expect(group?.props['aria-label']).toBe(group?.props.accessibilityLabel);
    });
});
