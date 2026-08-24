import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: Record<string, unknown>) => options.ios ?? options.default,
    },
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), confirm: vi.fn() },
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

import { useSecretRequirementFlow } from './useSecretRequirementFlow';

describe('useSecretRequirementFlow draft route identity', () => {
    it('carries the active draft UUID into the native secret picker', async () => {
        const routerPush = vi.fn();
        const hook = await renderHook(() => useSecretRequirementFlow({
            draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            router: { push: routerPush },
            navigation: {},
            useProfiles: true,
            selectedProfileId: 'profile-1',
            selectedProfile: null,
            setSelectedProfileId: vi.fn(),
            shouldShowSecretSection: true,
            selectedMachineId: 'machine-1',
            machineEnvPresence: {
                isPreviewEnvSupported: false,
                isLoading: false,
                meta: {},
                refreshedAt: null,
                refresh: vi.fn(),
            },
            secrets: [],
            setSecrets: vi.fn(),
            secretBindingsByProfileId: {},
            setSecretBindingsByProfileId: vi.fn(),
            selectedSecretIdByProfileIdByEnvVarName: {},
            setSelectedSecretIdByProfileIdByEnvVarName: vi.fn(),
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            setSessionOnlySecretValueByProfileIdByEnvVarName: vi.fn(),
            secretRequirementResultId: undefined,
            prevProfileIdBeforeSecretPromptRef: React.createRef<string | null>() as React.MutableRefObject<string | null>,
            lastSecretPromptKeyRef: React.createRef<string | null>() as React.MutableRefObject<string | null>,
            suppressNextSecretAutoPromptKeyRef: React.createRef<string | null>() as React.MutableRefObject<string | null>,
            isSecretRequirementModalOpenRef: React.createRef<boolean>() as React.MutableRefObject<boolean>,
        }));

        hook.getCurrent().openSecretRequirementModal({
            id: 'profile-1',
            name: 'Profile',
            envVarRequirements: [{ name: 'API_TOKEN', required: true, kind: 'secret' }],
        } as never, { revertOnCancel: true });

        expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
            }),
        }));
    });
});
