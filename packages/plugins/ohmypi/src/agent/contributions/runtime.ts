import {
  createOhMyPiAuthMaterializationInput,
  materializeOhMyPiAuthEnvironment,
  OH_MY_PI_SUPPORTED_AUTH_SERVICE_IDS,
  readOhMyPiConnectedServiceId,
} from '../auth/services/materialization.js';
import { verifyResumeReachableOhMyPi } from '../connectedServices/reachability.js';
import { createOhMyPiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/runtimeAuthAdapter.js';
import { ohMyPiConnectedServiceStateSharingDescriptor } from '../connectedServices/stateSharing.js';
import { OH_MY_PI_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';
import { resolveSessionFileStoreLaunchEnvironment } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../sessionFileStoreDescriptor.js';

export const OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'ohMyPi',
  sessionRuntimePreferences: {
    resolve: (params: Readonly<{
      settings?: Readonly<Record<string, unknown>>;
      processEnv: Readonly<Record<string, string | undefined>>;
    }>) => {
      const environmentVariables = resolveSessionFileStoreLaunchEnvironment({
        product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
        settings: params.settings,
        env: params.processEnv,
      });
      return Object.freeze(Object.keys(environmentVariables).length > 0
        ? { environmentVariables }
        : {});
    },
  },
  preflightSessionControls: OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
  connectedServices: {
    serviceIds: OH_MY_PI_SUPPORTED_AUTH_SERVICE_IDS,
    materializedRootSubdir: 'ohmypi-auth',
    readConnectedServiceId: readOhMyPiConnectedServiceId,
    createAuthMaterializationInput: createOhMyPiAuthMaterializationInput,
    materializeAuthEnvironment: materializeOhMyPiAuthEnvironment,
    stateSharingDescriptor: ohMyPiConnectedServiceStateSharingDescriptor,
    runtimeAuthAdapter: createOhMyPiConnectedServiceRuntimeAuthAdapter(),
    shouldRestartForServiceSwitch: (selection: unknown) =>
      readOhMyPiConnectedServiceId(selection) !== null,
    restartRematerializeRequiredReason: 'ohmypi_restart_rematerialize_required',
    sameAuthGroupRequiresResumeReachability: true,
    verifyResumeReachable: verifyResumeReachableOhMyPi,
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'per_session_runtime',
    },
  },
} as const);
