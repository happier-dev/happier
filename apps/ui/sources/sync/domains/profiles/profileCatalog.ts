import { type AIBackendProfile } from './profileCompatibility';
import { DEFAULT_BUILT_IN_BACKEND_PROFILES, getBuiltInBackendProfile } from '@happier-dev/protocol';

/**
 * Get a built-in AI backend profile by ID.
 * Built-in profiles provide sensible defaults for popular AI providers.
 *
 * ENVIRONMENT VARIABLE FLOW:
 * 1. User launches daemon with env vars: Z_AI_AUTH_TOKEN=sk-... Z_AI_BASE_URL=https://api.z.ai
 * 2. Profile defines mappings: ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN}
 * 3. When spawning session, daemon expands ${VAR} from its process.env
 * 4. Session receives: ANTHROPIC_AUTH_TOKEN=sk-... (actual value)
 * 5. Claude CLI reads ANTHROPIC_* env vars, connects to Z.AI
 *
 * This pattern lets users:
 * - Set credentials ONCE when launching daemon
 * - Switch backends by selecting different profiles
 * - Each profile maps daemon env vars to what CLI expects
 *
 * @param id - The profile ID (anthropic, deepseek, zai, openai, azure-openai, together)
 * @returns The complete profile configuration, or null if not found
 */
export const getBuiltInProfile = (id: string): AIBackendProfile | null => {
    return getBuiltInBackendProfile(id);
};

/**
 * Default built-in profiles available to all users.
 * These provide quick-start configurations for popular AI providers.
 */
export const DEFAULT_PROFILES = [
    ...DEFAULT_BUILT_IN_BACKEND_PROFILES.map((profile) => ({
        id: profile.id,
        name: profile.name,
        isBuiltIn: true,
    })),
] as const;
