import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useNewSessionProfileSelectionPresentation } from './useNewSessionProfileSelectionPresentation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('useNewSessionProfileSelectionPresentation', () => {
    it('keeps the refused Profile visible with its launch reason while other Profiles remain selectable', async () => {
        const selectProfile = vi.fn();
        const profileLaunchFailure = { profileId: 'profile-1', message: 'profile_overlay_mismatch' };
        const { getCurrent } = await renderHook(() => useNewSessionProfileSelectionPresentation({
            useProfiles: true,
            selectedProfileId: profileLaunchFailure.profileId,
            setSelectedProfileId: () => {},
            selectProfile,
            canSelectProfile: () => true,
            profileAvailabilityById: new Map(),
            profileLaunchFailure,
            clearProfileRouteParam: () => {},
        }));

        expect(getCurrent().getProfileSubtitleExtra({ id: 'profile-1' })).toBe(profileLaunchFailure.message);
        expect(getCurrent().getProfileSubtitleExtra({ id: 'profile-2' })).toBeNull();
        expect(getCurrent().getProfileDisabled({ id: 'profile-1' })).toBe(false);
        getCurrent().onPressProfile({ id: 'profile-2' });
        expect(selectProfile).toHaveBeenCalledWith('profile-2');
    });

    it('shows the logged-out advisory subtitle for logged-out profiles', async () => {
        const { getCurrent } = await renderHook(() => useNewSessionProfileSelectionPresentation({
            useProfiles: false,
            selectedProfileId: null,
            setSelectedProfileId: () => {},
            selectProfile: () => {},
            canSelectProfile: () => false,
            profileAvailabilityById: new Map([
                ['profile-1', { available: false, reason: 'logged-out:any' }],
            ]),
            clearProfileRouteParam: () => {},
        }));

        expect(getCurrent().getProfileSubtitleExtra({ id: 'profile-1' })).toBe('profiles.machineLogin.status.notLoggedIn');
    });

    it('keeps structurally supported profiles selectable even when availability only has a logged-out advisory', async () => {
        const selectProfile = vi.fn();
        const { getCurrent } = await renderHook(() => useNewSessionProfileSelectionPresentation({
            useProfiles: true,
            selectedProfileId: null,
            setSelectedProfileId: () => {},
            selectProfile,
            canSelectProfile: (profileId) => profileId === 'profile-1',
            profileAvailabilityById: new Map([
                ['profile-1', { available: false, reason: 'logged-out:any' }],
            ]),
            clearProfileRouteParam: () => {},
        }));

        expect(getCurrent().getProfileDisabled({ id: 'profile-1' })).toBe(false);

        getCurrent().onPressProfile({ id: 'profile-1' });

        expect(selectProfile).toHaveBeenCalledWith('profile-1');
    });

    it('rejects a routed profile id when the profile is not selectable and still clears the param', async () => {
        const selectProfile = vi.fn();
        const clearProfileRouteParam = vi.fn();

        await renderHook(() => useNewSessionProfileSelectionPresentation({
            useProfiles: true,
            profileIdParam: 'profile-1',
            selectedProfileId: null,
            setSelectedProfileId: () => {},
            selectProfile,
            canSelectProfile: () => false,
            profileAvailabilityById: new Map(),
            clearProfileRouteParam,
        }));

        expect(selectProfile).not.toHaveBeenCalled();
        expect(clearProfileRouteParam).toHaveBeenCalledTimes(1);
    });

    afterEach(() => {
        standardCleanup();
    });
});
