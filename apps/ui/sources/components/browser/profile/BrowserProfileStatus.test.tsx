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

const permissionGrant = {
    id: 'grant_1',
    profileId: 'profile_1',
    browserSessionId: 'browser_session_1',
    origin: 'https://preview.happier.test',
    permission: 'clipboard',
    state: 'allowed',
    scope: 'session',
    updatedAt: 1_000,
} as const;

describe('BrowserProfileStatus', () => {
    it('renders management actions as unavailable when no product owner callback exists', async () => {
        const screen = await renderScreen(
            <BrowserProfileStatus
                model={{
                    profile,
                    storagePartition,
                    activePermissionGrantCount: 1,
                    management: {
                        availableProfiles: [profile],
                        permissionGrants: [permissionGrant],
                        storagePartitions: [storagePartition],
                    },
                }}
                testID="browser-profile"
            />,
        );

        expect(screen.findByTestId('browser-profile-profile-create-unavailable')?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        expect(screen.findByTestId('browser-profile-profile-select-profile_1-unavailable')?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        expect(screen.findByTestId('browser-profile-permission-revoke-grant_1-unavailable')?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        expect(screen.findByTestId('browser-profile-storage-clear-partition_1-unavailable')?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
    });

    it('enables profile, permission, and storage actions only when owner callbacks are supplied', async () => {
        const onCreateProfile = vi.fn();
        const onSelectProfile = vi.fn();
        const onRevokePermissionGrant = vi.fn();
        const onClearStoragePartition = vi.fn();

        const screen = await renderScreen(
            <BrowserProfileStatus
                model={{
                    profile,
                    storagePartition,
                    activePermissionGrantCount: 1,
                    management: {
                        availableProfiles: [profile],
                        permissionGrants: [permissionGrant],
                        storagePartitions: [storagePartition],
                        onCreateProfile,
                        onSelectProfile,
                        onRevokePermissionGrant,
                        onClearStoragePartition,
                    },
                }}
                testID="browser-profile"
            />,
        );

        screen.pressByTestId('browser-profile-profile-create');
        screen.pressByTestId('browser-profile-profile-select-profile_1');
        screen.pressByTestId('browser-profile-permission-revoke-grant_1');
        screen.pressByTestId('browser-profile-storage-clear-partition_1');

        expect(onCreateProfile).toHaveBeenCalledTimes(1);
        expect(onSelectProfile).toHaveBeenCalledWith('profile_1');
        expect(onRevokePermissionGrant).toHaveBeenCalledWith('grant_1');
        expect(onClearStoragePartition).toHaveBeenCalledWith('partition_1');
    });
});
