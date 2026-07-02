import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';

import { installProfilesCommonModuleMocks } from './profilesTestHelpers';

const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

installProfilesCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/hooks/session/useProfileEnvRequirements', () => ({
    useProfileEnvRequirements: () => ({ isReady: false, isLoading: false }),
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    hasRequiredSecret: () => true,
}));

type TextMockProps = {
    children?: React.ReactNode;
} & Record<string, unknown>;

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: TextMockProps) => React.createElement('Text', props as never, children),
}));

const profile: AIBackendProfile = {
    id: 'p1',
    name: 'Profile',
    environmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: {},
    compatibility: {},
    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
    isBuiltIn: false,
    defaultEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
};

describe('ProfileRequirementsBadge', () => {
    it('does not emit raw text nodes under View when icons render as text on web', async () => {
        const { ProfileRequirementsBadge } = await import('./ProfileRequirementsBadge');

        const screen = await renderScreen(
            <ProfileRequirementsBadge
                profile={profile}
                machineId={null}
            />,
        );

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);

        act(() => {
            screen.tree.unmount();
        });
    });
});
