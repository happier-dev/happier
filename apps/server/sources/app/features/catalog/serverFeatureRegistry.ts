import type { FeaturesPayloadDelta, FeaturesResponse } from '../types';

import { resolveAutomationsFeature } from '../automationsFeature';
import { resolveWorkflowsFeature } from '../workflowsFeature';
import { resolveBugReportsFeature } from '../bugReportsFeature';
import { resolveSharingFeature } from '../sharingFeature';
import { resolveVoiceFeature } from '../voiceFeature';
import { resolveFriendsFeature } from '../friendsFeature';
import { resolveOAuthFeature } from '../oauthFeature';
import { resolveAuthFeature } from '../authFeature';
import { resolveConnectedServicesFeature } from '../connectedServicesFeature';
import { resolveUpdatesFeature } from '../updatesFeature';
import { resolveAttachmentsUploadsFeature } from '../attachmentsUploadsFeature';
import { resolvePetsFeature } from '../petsFeature';
import { resolveMachineTransferFeature } from '../machineTransferFeature';
import { resolveMachineTunnelFeature } from '../machineTunnelFeature';
import { resolvePeerMediationFeature } from '../peerMediationFeature';
import { resolveMachineLiveStreamFeature } from '../machineLiveStreamFeature';
import { resolveMachineRpcFeature } from '../machineRpcFeature';
import { resolveMachinePoolsFeature } from '../machinePoolsFeature';
import { resolveLocalServicesFeature } from '../localServicesFeature';
import { resolveProvidersFeature } from '../providersFeature';
import { resolveSearchFeature } from '../searchFeature';
import { resolveTeamsFeature } from '../teamsFeature';
import { resolveBrowserFeature } from '../browserFeature';
import { resolvePluginsFeature } from '../pluginsFeature';
import { resolveDevicesFeature } from '../devicesFeature';
import { resolveSessionFoldersFeature } from '../sessionFoldersFeature';
import { resolveSessionDraftsFeature } from '../sessionDraftsFeature';
import { resolveSessionBoardFeature } from '../sessionBoardFeature';
import { resolveSessionFollowingFeature } from '../sessionFollowingFeature';
import { resolveSessionFilteredListingFeature } from '../sessionFilteredListingFeature';
import { resolveSessionEphemeralRunnerFeature } from '../sessionEphemeralRunnerFeature';
import { resolveSessionAgentSwitchingFeature } from '../sessionAgentSwitchingFeature';
import { resolveSessionHandoffFeature } from '../sessionHandoffFeature';
import { resolveSessionUsageLimitRecoveryFeature } from '../sessionUsageLimitRecoveryFeature';
import { resolveTerminalFeature } from '../terminalFeature';
import { resolveEncryptionFeature } from '../encryptionFeature';
import { resolveE2eeFeature } from '../e2eeFeature';
import { resolveServerUrlCapabilitiesFeature } from '../serverUrlCapabilitiesFeature';
import { resolveServerRetentionCapabilitiesFeature } from '../serverRetentionCapabilitiesFeature';
import { resolveServerUsageAnalyticsCapabilitiesFeature } from '../serverUsageAnalyticsCapabilitiesFeature';
import { resolveLiveActivityRemoteUpdatesFeature } from '../liveActivityRemoteUpdatesFeature';
import { resolveSessionProtocolCapabilitiesFeature } from '../sessionProtocolCapabilitiesFeature';
import { resolveAccountStoredContentCompatibilityFeature } from '../accountStoredContentCompatibilityFeature';
import { resolveAccountDirectoryFeature } from '../accountDirectoryFeature';
import { resolveSessionConversationsFeature } from '../sessionConversationsFeature';

export type ServerFeatureResolver = ((env: NodeJS.ProcessEnv) => FeaturesPayloadDelta) & Readonly<{
    /** Every feature root this producer writes; empty for a diagnostic-only producer. */
    featureRoots?: readonly (keyof FeaturesResponse['features'])[];
}>;

function register(
    featureRoots: readonly (keyof FeaturesResponse['features'])[],
    resolver: ServerFeatureResolver,
): ServerFeatureResolver {
    return Object.freeze(Object.assign(resolver, { featureRoots: Object.freeze(featureRoots) }));
}

export const serverFeatureRegistry = Object.freeze([
    register([], () => resolveAccountStoredContentCompatibilityFeature()),
    register([], (env) => resolveAccountDirectoryFeature(env)),
    register([], () => resolveSessionProtocolCapabilitiesFeature()),
    register([], (env) => resolveServerUrlCapabilitiesFeature(env)),
    register([], (env) => resolveServerRetentionCapabilitiesFeature(env)),
    register([], () => resolveServerUsageAnalyticsCapabilitiesFeature()),
    register([], (env) => resolveLiveActivityRemoteUpdatesFeature(env)),
    register(['bugReports'], (env) => resolveBugReportsFeature(env)),
    register(['automations'], (env) => resolveAutomationsFeature(env)),
    register(['workflows'], (env) => resolveWorkflowsFeature(env)),
    register(['sharing'], (_env) => resolveSharingFeature()),
    register(['voice'], (env) => resolveVoiceFeature(env)),
    register(['connectedServices'], (env) => resolveConnectedServicesFeature(env)),
    register(['updates'], (env) => resolveUpdatesFeature(env)),
    register(['attachments'], (env) => resolveAttachmentsUploadsFeature(env)),
    register(['pets'], (env) => resolvePetsFeature(env)),
    register(['machines'], (env) => resolveMachineTransferFeature(env)),
    register(['machines'], (env) => resolveMachineTunnelFeature(env)),
    register(['machines'], (env) => resolvePeerMediationFeature(env)),
    register(['localServices'], (env) => resolveLocalServicesFeature(env)),
    register(['providers'], (env) => resolveProvidersFeature(env)),
    register(['search'], (env) => resolveSearchFeature(env)),
    register(['teams'], (env) => resolveTeamsFeature(env)),
    register(['browser'], (env) => resolveBrowserFeature(env)),
    register(['plugins'], (env) => resolvePluginsFeature(env)),
    register(['devices'], (env) => resolveDevicesFeature(env)),
    register(['machines'], (env) => resolveMachineLiveStreamFeature(env)),
    register(['machines'], (env) => resolveMachineRpcFeature(env)),
    register(['machines'], (env) => resolveMachinePoolsFeature(env)),
    register(['sessions'], (env) => resolveSessionFoldersFeature(env)),
    register(['sessions'], (env) => resolveSessionDraftsFeature(env)),
    register(['sessions'], (env) => resolveSessionBoardFeature(env)),
    register(['sessions'], (env) => resolveSessionFollowingFeature(env)),
    register(['sessions'], (env) => resolveSessionConversationsFeature(env)),
    register(['sessions'], (env) => resolveSessionFilteredListingFeature(env)),
    register(['sessions'], (env) => resolveSessionEphemeralRunnerFeature(env)),
    register(['sessions'], (env) => resolveSessionAgentSwitchingFeature(env)),
    register(['sessions'], (env) => resolveSessionHandoffFeature(env)),
    register(['sessions'], (env) => resolveSessionUsageLimitRecoveryFeature(env)),
    register(['terminal'], (env) => resolveTerminalFeature(env)),
    register(['social'], (env) => resolveFriendsFeature(env)),
    register([], (env) => resolveOAuthFeature(env)),
    register(['auth'], (env) => resolveAuthFeature(env)),
    register(['encryption'], (env) => resolveEncryptionFeature(env)),
    register(['e2ee'], (env) => resolveE2eeFeature(env)),
] satisfies readonly ServerFeatureResolver[]);
