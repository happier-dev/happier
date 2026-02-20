import type { FeaturesPayloadDelta } from '@/app/features/types';

import { resolveAutomationsFeature } from '@/app/features/automationsFeature';
import { resolveBugReportsFeature } from '@/app/features/bugReportsFeature';
import { resolveSharingFeature } from '@/app/features/sharingFeature';
import { resolveVoiceFeature } from '@/app/features/voiceFeature';
import { resolveFriendsFeature } from '@/app/features/friendsFeature';
import { resolveOAuthFeature } from '@/app/features/oauthFeature';
import { resolveAuthFeature } from '@/app/features/authFeature';
import { resolveConnectedServicesFeature } from '@/app/features/connectedServicesFeature';
import { resolveUpdatesFeature } from '@/app/features/updatesFeature';
import { resolveAttachmentsUploadsFeature } from '@/app/features/attachmentsUploadsFeature';
import { resolveEncryptionFeature } from '@/app/features/encryptionFeature';

export type ServerFeatureResolver = (env: NodeJS.ProcessEnv) => FeaturesPayloadDelta;

export const serverFeatureRegistry: readonly ServerFeatureResolver[] = Object.freeze([
    (env) => resolveBugReportsFeature(env),
    (env) => resolveAutomationsFeature(env),
    (_env) => resolveSharingFeature(),
    (env) => resolveVoiceFeature(env),
    (env) => resolveConnectedServicesFeature(env),
    (env) => resolveUpdatesFeature(env),
    (env) => resolveAttachmentsUploadsFeature(env),
    (env) => resolveFriendsFeature(env),
    (env) => resolveOAuthFeature(env),
    (env) => resolveAuthFeature(env),
    (env) => resolveEncryptionFeature(env),
]);
