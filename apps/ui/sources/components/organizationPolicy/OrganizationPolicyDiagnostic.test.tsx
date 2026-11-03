import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks();
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });
await import('./OrganizationPolicyFieldNotice');

describe('organization policy diagnostic', () => {
    it('shows the typed failure beside usable app content without leaking policy values', async () => {
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), __HAPPIER_WEB_RUNTIME_CONFIG__: {
            organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example Co',
                home: { url: 'invalid-private-value', locked: true } }),
        } });
        const { OrganizationPolicyDiagnostic } = await import('./OrganizationPolicyFieldNotice');
        const screen = await renderScreen(<>
            <OrganizationPolicyDiagnostic />
            <View testID="ordinary-app-content" />
        </>);
        expect(screen.findByTestId('organization-policy-invalid')).not.toBeNull();
        expect(screen.findByTestId('ordinary-app-content')).not.toBeNull();
        expect(screen.getTextContent()).toContain('home.url');
        expect(screen.getTextContent()).not.toContain('invalid-private-value');
    });

    it('does not display native policy diagnostics in a browser', async () => {
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), __HAPPIER_WEB_RUNTIME_CONFIG__: {
            organizationPolicyError: { path: '$', code: 'read_failed' },
        } });
        const { OrganizationPolicyDiagnostic } = await import('./OrganizationPolicyFieldNotice');
        const screen = await renderScreen(<OrganizationPolicyDiagnostic />);
        expect(screen.findByTestId('organization-policy-invalid')).toBeNull();
    });
});
