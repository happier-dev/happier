import {
  createOhMyPiAuthMaterializationInput,
  materializeOhMyPiAuthEnvironment,
  OH_MY_PI_SUPPORTED_AUTH_SERVICE_IDS,
  readOhMyPiConnectedServiceId,
} from '../auth/services/materialization.js';
import { verifyResumeReachableOhMyPi } from '../connectedServices/reachability.js';
import { createOhMyPiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/runtimeAuthAdapter.js';
import { ohMyPiConnectedServiceStateSharingDescriptor } from '../connectedServices/stateSharing.js';
import { resolveOhMyPiConnectedServiceSwitchContinuity } from '../connectedServices/switchContinuity.js';
import { OH_MY_PI_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';
import { createOhMyPiExternalSessionTranscriptStoreAdapter } from '../surfaces/sessions/external/transcriptStoreAdapter.js';

export const OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'ohMyPi',
  preflightSessionControls: OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
  connectedServices: {
    serviceIds: OH_MY_PI_SUPPORTED_AUTH_SERVICE_IDS,
    materializedRootSubdir: 'ohmypi-auth',
    readConnectedServiceId: readOhMyPiConnectedServiceId,
    createAuthMaterializationInput: createOhMyPiAuthMaterializationInput,
    materializeAuthEnvironment: materializeOhMyPiAuthEnvironment,
    stateSharingDescriptor: ohMyPiConnectedServiceStateSharingDescriptor,
    runtimeAuthAdapter: createOhMyPiConnectedServiceRuntimeAuthAdapter(),
  },
  runtimeControl: {
    connectedServices: {
      resolveSwitchContinuity: resolveOhMyPiConnectedServiceSwitchContinuity,
      verifyResumeReachable: verifyResumeReachableOhMyPi,
    },
  },
  externalSessions: {
    createTranscriptStoreAdapter: createOhMyPiExternalSessionTranscriptStoreAdapter,
  },
} as const);
