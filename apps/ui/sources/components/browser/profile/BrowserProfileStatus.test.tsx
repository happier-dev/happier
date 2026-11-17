import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { BrowserProfileStatus } from './BrowserProfileStatus';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const profile = {
    profileId: 'profile_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    displayName: 'Session preview',
    lifecycleState: 'active',
    cleanupOnSessionClose: true,
} as const;

const storagePartition = {
    partitionId: 'partition_1',
    profileId: 'profile_1',
    originKey: 'https://preview.happier.test',
    targetKind: 'localServicePreview',
    persistence: 'session',
    state: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
} as const;

describe('BrowserProfileStatus', () => {
    it('names the profile first and says what it keeps, without dormant management controls when no Machine source exists', async () => {
        const screen = await renderScreen(<BrowserProfileStatus model={{ profile, storagePartition,
            activePermissionGrantCount: 1 }} testID="browser-profile" />);
        const identity = screen.findByTestId('browser-profile-identity');
        expect(identity).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).toContain('Session preview');
        expect(text).toContain('browserShell.profile.storage.session');
        expect(text).toContain('browserShell.profile.permissions.active');
        expect(screen.findByTestId('browser-profile-management')).toBeFalsy();
    });

    it('names an unnamed profile by its kind', async () => {
        const { displayName: _name, ...unnamed } = profile;
        const screen = await renderScreen(<BrowserProfileStatus model={{ profile: unnamed, storagePartition: null }} testID="browser-profile" />);
        const text = screen.getTextContent();
        expect(text).toContain('browserShell.profile.name.session');
        expect(text).toContain('browserShell.profile.storage.unavailable');
    });

    it.each([undefined, 'allowed'] as const)('keeps an unobserved permission count unavailable with state %s', async (permissionState) => {
        const screen = await renderScreen(<BrowserProfileStatus model={{ profile, permissionState }} />);
        const text = screen.getTextContent();
        expect(text).toContain('common.unavailable');
        expect(text).not.toContain('browserShell.profile.permissions.none');
    });

    it('shows no site permissions only for an observed zero count', async () => {
        const screen = await renderScreen(<BrowserProfileStatus model={{ profile, storagePartition,
            activePermissionGrantCount: 0 }} />);
        expect(screen.getTextContent()).toContain('browserShell.profile.permissions.none');
    });

    it.each(['denied', 'prompt'] as const)('preserves an observed %s permission policy without a grant count', async (permissionState) => {
        const screen = await renderScreen(<BrowserProfileStatus model={{ profile, permissionState }} />);
        expect(screen.getTextContent()).toContain(`browserShell.profile.permissions.${permissionState}`);
    });
});
