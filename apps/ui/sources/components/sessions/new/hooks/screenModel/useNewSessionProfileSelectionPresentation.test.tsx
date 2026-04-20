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
