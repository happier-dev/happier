import { type AIBackendProfile } from './profileCompatibility';
import { DEFAULT_BUILT_IN_BACKEND_PROFILES, getBuiltInBackendProfile } from '@happier-dev/protocol';

/**
 * Read a generated legacy built-in launch profile for compatibility and migration.
 * Provider-like entries are not the user-facing provider catalog; visibility is
 * decided by the protocol migration policy and new writes use LaunchProfileV2.
 */
export const getBuiltInProfile = (id: string): AIBackendProfile | null => {
    return getBuiltInBackendProfile(id);
};

/** Generated legacy catalog metadata retained for compatibility projections. */
export const DEFAULT_PROFILES = [
    ...DEFAULT_BUILT_IN_BACKEND_PROFILES.map((profile) => ({
        id: profile.id,
        name: profile.name,
        isBuiltIn: true,
    })),
] as const;
