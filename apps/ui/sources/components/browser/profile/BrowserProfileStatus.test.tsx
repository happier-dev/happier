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
    it('shows profile facts without dormant management controls when no Machine source exists', async () => {
        const screen = await renderScreen(<BrowserProfileStatus model={{ profile, storagePartition,
            activePermissionGrantCount: 1 }} testID="browser-profile" />);
        expect(screen.findByTestId('browser-profile-mode-session')).toBeTruthy();
        expect(screen.findByTestId('browser-profile-storage-session')).toBeTruthy();
        expect(screen.findByTestId('browser-profile-permissions-active')).toBeTruthy();
        expect(screen.findByTestId('browser-profile-management')).toBeFalsy();
    });
});
