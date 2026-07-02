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
import { resolveMachineTunnelFeature } from '../machineTunnelFeature';
import { resolveMachineLiveStreamFeature } from '../machineLiveStreamFeature';
import { resolveMachineRpcFeature } from '../machineRpcFeature';
import { resolveLocalServicesFeature } from '../localServicesFeature';
import { resolveSessionFoldersFeature } from '../sessionFoldersFeature';
import { resolveSessionHandoffFeature } from '../sessionHandoffFeature';
import { resolveSessionUsageLimitRecoveryFeature } from '../sessionUsageLimitRecoveryFeature';
import { resolveTerminalFeature } from '../terminalFeature';
import { resolveEncryptionFeature } from '../encryptionFeature';
import { resolveE2eeFeature } from '../e2eeFeature';
import { resolveServerUrlCapabilitiesFeature } from '../serverUrlCapabilitiesFeature';
import { resolveServerRetentionCapabilitiesFeature } from '../serverRetentionCapabilitiesFeature';
import { resolveServerUsageAnalyticsCapabilitiesFeature } from '../serverUsageAnalyticsCapabilitiesFeature';
import { resolveLiveActivityRemoteUpdatesFeature } from '../liveActivityRemoteUpdatesFeature';

export type ServerFeatureResolver = (env: NodeJS.ProcessEnv) => FeaturesPayloadDelta;

export const serverFeatureRegistry: readonly ServerFeatureResolver[] = Object.freeze([
    (env) => resolveServerUrlCapabilitiesFeature(env),
    (env) => resolveServerRetentionCapabilitiesFeature(env),
    () => resolveServerUsageAnalyticsCapabilitiesFeature(),
    (env) => resolveLiveActivityRemoteUpdatesFeature(env),
    (env) => resolveBugReportsFeature(env),
    (env) => resolveAutomationsFeature(env),
    (_env) => resolveSharingFeature(),
    (env) => resolveVoiceFeature(env),
    (env) => resolveConnectedServicesFeature(env),
    (env) => resolveChannelBridgesFeature(env),
    (env) => resolveUpdatesFeature(env),
    (env) => resolveAttachmentsUploadsFeature(env),
    (env) => resolvePetsFeature(env),
    (env) => resolveMachineTransferFeature(env),
    (env) => resolveMachineTunnelFeature(env),
    (env) => resolveLocalServicesFeature(env),
    (env) => resolveMachineLiveStreamFeature(env),
    (env) => resolveMachineRpcFeature(env),
    (env) => resolveSessionFoldersFeature(env),
    (env) => resolveSessionHandoffFeature(env),
    (env) => resolveSessionUsageLimitRecoveryFeature(env),
    (env) => resolveTerminalFeature(env),
    (env) => resolveFriendsFeature(env),
    (env) => resolveOAuthFeature(env),
    (env) => resolveAuthFeature(env),
    (env) => resolveEncryptionFeature(env),
    (env) => resolveE2eeFeature(env),
]);
