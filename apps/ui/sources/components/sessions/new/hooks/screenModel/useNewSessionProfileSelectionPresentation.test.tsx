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
            profileAvailabilityById: new Map([
                ['profile-1', { available: false, reason: 'logged-out:any' }],
            ]),
            clearProfileRouteParam: () => {},
        }));

        expect(getCurrent().getProfileSubtitleExtra({ id: 'profile-1' })).toBe('profiles.machineLogin.status.notLoggedIn');
    });

    afterEach(() => {
        standardCleanup();
    });
});
