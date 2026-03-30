import { vi } from 'vitest';

import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { ProfilesListProps } from '@/components/profiles/ProfilesList';
import {
    AIBackendProfileSchema,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';
import {
    settingsDefaults,
    type Settings,
} from '@/sync/domains/settings/settings';

export const PROFILE_SECRET_REQUIREMENT_ENV_VAR = 'DEESEEK_AUTH_TOKEN';

export const profileSecretRequirementModalMock = createModalModuleMock();

export type CapturedProfilesListProps = Pick<ProfilesListProps, 'onPressProfile'>;

let capturedProfilesListProps: CapturedProfilesListProps | null = null;

export function captureProfilesListProps(props: CapturedProfilesListProps) {
    capturedProfilesListProps = props;
}

export function resetProfileSecretRequirementHarness() {
    capturedProfilesListProps = null;
    profileSecretRequirementModalMock.spies.show.mockReset();
    profileSecretRequirementModalMock.spies.alert.mockReset();
    profileSecretRequirementModalMock.spies.prompt.mockReset();
    profileSecretRequirementModalMock.spies.confirm.mockReset();
}

export function getCapturedProfilePressHandler() {
    const onPressProfile = capturedProfilesListProps?.onPressProfile;
    if (!onPressProfile) {
        throw new Error('Expected ProfilesList onPressProfile handler');
    }
    return onPressProfile;
}

export function getProfileSecretRequirementSetting<K extends keyof Settings>(key: K): Settings[K] {
    if (key === 'useProfiles') return true as Settings[K];
    if (key === 'experiments') return false as Settings[K];
    return false as Settings[K];
}

export function useProfileSecretRequirementSettingMutable<K extends keyof Settings>(
    key: K,
): [Settings[K], (value: Settings[K]) => void] {
    return [
        settingsDefaults[key],
        vi.fn<(value: Settings[K]) => void>(),
    ];
}

export function createMissingRequiredSecretScenario(): Readonly<{
    profile: AIBackendProfile;
    secretEnvVarName: string;
    secretEnvVarNames: readonly string[];
}> {
    return {
        profile: AIBackendProfileSchema.parse({
            id: 'deepseek',
            name: 'DeepSeek',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: {},
            compatibility: { codex: true, customAcp: false },
            compatibilityByTargetKey: {},
            envVarRequirements: [],
            isBuiltIn: true,
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
        }),
        secretEnvVarName: PROFILE_SECRET_REQUIREMENT_ENV_VAR,
        secretEnvVarNames: [PROFILE_SECRET_REQUIREMENT_ENV_VAR],
    } as const;
}
