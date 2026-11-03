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
afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    const { resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
    resetServerProfilesRuntimeForTests();
});

// Collect the real owner graph before the behavior test deadline starts.
await import('./HomeAddForm');

describe('Add Home phone path selection', () => {
    it('explains an organization-locked Home and keeps the way out available', async () => {
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), __HAPPIER_WEB_RUNTIME_CONFIG__: {
            organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example Co',
                home: { url: 'https://home.example.test', locked: true } }),
        } });
        const onClose = vi.fn();
        const { HomeAddForm } = await import('./HomeAddForm');
        const screen = await renderScreen(<HomeAddForm layout="page" testID="add-home" onClose={onClose} />);
        expect(screen.findByTestId('organization-policy-home')).not.toBeNull();
        expect(screen.findByTestId('add-home.blocked')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('add-home.close');
        expect(onClose).toHaveBeenCalledOnce();
    });

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
