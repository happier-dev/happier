import type { FeaturesResponse } from '@/app/features/types';

import { resolveAutomationsFeature } from '@/app/features/automationsFeature';
import { resolveBugReportsFeature } from '@/app/features/bugReportsFeature';
import { resolveSharingFeature } from '@/app/features/sharingFeature';
import { resolveVoiceFeature } from '@/app/features/voiceFeature';
import { resolveFriendsFeature } from '@/app/features/friendsFeature';
import { resolveOAuthFeature } from '@/app/features/oauthFeature';
import { resolveAuthFeature } from '@/app/features/authFeature';

export type ServerFeatureResolver = (env: NodeJS.ProcessEnv) => Partial<FeaturesResponse['features']>;

export const serverFeatureRegistry: readonly ServerFeatureResolver[] = Object.freeze([
    (env) => resolveBugReportsFeature(env),
    (env) => resolveAutomationsFeature(env),
    (_env) => resolveSharingFeature(),
    (env) => resolveVoiceFeature(env),
    (env) => resolveFriendsFeature(env),
    (env) => resolveOAuthFeature(env),
    (env) => resolveAuthFeature(env),
]);
