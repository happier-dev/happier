import type { FeaturesPayloadDelta } from '../types';

import { resolveAutomationsFeature } from '../automationsFeature';
import { resolveBugReportsFeature } from '../bugReportsFeature';
import { resolveSharingFeature } from '../sharingFeature';
import { resolveVoiceFeature } from '../voiceFeature';
import { resolveFriendsFeature } from '../friendsFeature';
import { resolveOAuthFeature } from '../oauthFeature';
import { resolveAuthFeature } from '../authFeature';
import { resolveConnectedServicesFeature } from '../connectedServicesFeature';
import { resolveChannelBridgesFeature } from '../channelBridgesFeature';
import { resolveUpdatesFeature } from '../updatesFeature';
import { resolveAttachmentsUploadsFeature } from '../attachmentsUploadsFeature';
import { resolvePetsFeature } from '../petsFeature';
import { resolveMachineTransferFeature } from '../machineTransferFeature';
import { resolveSessionFoldersFeature } from '../sessionFoldersFeature';
import { resolveSessionDraftsFeature } from '../sessionDraftsFeature';
import { resolveSessionHandoffFeature } from '../sessionHandoffFeature';
import { resolveSessionUsageLimitRecoveryFeature } from '../sessionUsageLimitRecoveryFeature';
import { resolveSessionAgentSwitchingFeature } from '../sessionAgentSwitchingFeature';
import { resolveTerminalFeature } from '../terminalFeature';
import { resolveEncryptionFeature } from '../encryptionFeature';
import { resolveE2eeFeature } from '../e2eeFeature';
import { resolveServerUrlCapabilitiesFeature } from '../serverUrlCapabilitiesFeature';
import { resolveServerRetentionCapabilitiesFeature } from '../serverRetentionCapabilitiesFeature';
import { resolveSessionProtocolCapabilitiesFeature } from '../sessionProtocolCapabilitiesFeature';

export type ServerFeatureResolver = (env: NodeJS.ProcessEnv) => FeaturesPayloadDelta;

const serverFeatureResolvers = [
    (env) => resolveServerUrlCapabilitiesFeature(env),
    (env) => resolveServerRetentionCapabilitiesFeature(env),
    () => resolveSessionProtocolCapabilitiesFeature(),
    (env) => resolveBugReportsFeature(env),
    (env) => resolveAutomationsFeature(env),
    (env) => resolveSharingFeature(env),
    (env) => resolveVoiceFeature(env),
    (env) => resolveConnectedServicesFeature(env),
    (env) => resolveChannelBridgesFeature(env),
    (env) => resolveUpdatesFeature(env),
    (env) => resolveAttachmentsUploadsFeature(env),
    (env) => resolvePetsFeature(env),
    (env) => resolveMachineTransferFeature(env),
    (env) => resolveSessionFoldersFeature(env),
    (env) => resolveSessionDraftsFeature(env),
    (env) => resolveSessionHandoffFeature(env),
    (env) => resolveSessionUsageLimitRecoveryFeature(env),
    (env) => resolveSessionAgentSwitchingFeature(env),
    (env) => resolveTerminalFeature(env),
    (env) => resolveFriendsFeature(env),
    (env) => resolveOAuthFeature(env),
    (env) => resolveAuthFeature(env),
    (env) => resolveEncryptionFeature(env),
    (env) => resolveE2eeFeature(env),
] satisfies readonly ServerFeatureResolver[];

export const serverFeatureRegistry: readonly ServerFeatureResolver[] =
    Object.freeze(serverFeatureResolvers);
