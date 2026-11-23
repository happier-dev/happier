import type { VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';

import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionSocketTransport } from '@/api/session/connection/createSessionSocketTransport';
import type { SessionClientTransport } from '@/api/session/client/transport/sessionClientTransport';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import type { SessionAttachSecret } from '@/agent/runtime/sessionAttach';
import { join } from 'node:path';
import type {
  DeferredStartupBackendApi,
  DeferredStartupBackendApiContextInitializer,
} from '@/agent/runtime/startup/createDeferredStartupBootstrap';

type CreateSessionSocketTransport = typeof createSessionSocketTransport;

export class EphemeralRunnerMaterializedSessionRequiredError extends Error {
  readonly code = 'ephemeral_runner_materialized_session_required' as const;

  constructor() {
    super('Ephemeral Runner can attach only to its already materialized Session');
    this.name = 'EphemeralRunnerMaterializedSessionRequiredError';
  }
}

/**
 * Exact Session transport for the already materialized Runner principal.
 * It never opens an Account updates socket and never creates or repairs an
 * AccessKey: the materialization transaction already established that binding.
 */
export function createRestrictedSessionClientTransport(
  params: Readonly<{
    principal: VerifiedEphemeralSessionRunnerPrincipal;
    serverId: string;
    runtimeOrigin: string;
    runtimeToken: string;
    /** Activation-local allowlist; ambient proxy/provider configuration is excluded. */
    transportEnvironment: NodeJS.ProcessEnv;
  }>,
  deps: Readonly<{
    createSessionSocketTransportFn?: CreateSessionSocketTransport;
  }> = {},
): SessionClientTransport {
  const createSessionSocketTransportFn = deps.createSessionSocketTransportFn
    ?? createSessionSocketTransport;
  return Object.freeze({
    serverId: params.serverId,
    serverUrl: params.runtimeOrigin,
    createSessionSocketTransport: (binding) => {
      if (
        binding.sessionId !== params.principal.sessionId
        || binding.machineId !== params.principal.machineId
      ) {
        throw new Error('ephemeral_runner_session_transport_scope_mismatch');
      }
      return createSessionSocketTransportFn({
        token: params.runtimeToken,
        serverUrl: params.runtimeOrigin,
        sessionId: params.principal.sessionId,
        machineId: params.principal.machineId,
        accessKeyBinding: 'preestablished',
        env: params.transportEnvironment,
      });
    },
    resolveToken: async () => params.runtimeToken,
  });
}

/**
 * Supplies the incumbent deferred host-session startup with only the exact
 * Session authority materialized for this Runner. This deliberately is not an
 * ApiClient: Account APIs, Account updates, Machine registration and Session
 * creation are absent.
 */
export function createRestrictedSessionBackendApiContextInitializer(params: Readonly<{
  principal: VerifiedEphemeralSessionRunnerPrincipal;
  serverId: string;
  runtimeOrigin: string;
  runtimeToken: string;
  transportEnvironment: NodeJS.ProcessEnv;
  actionsSettingsProvider: RuntimeActionSettingsProvider;
  onSessionFollowInvalidated?: () => void;
  installSessionFollowWakeReceiver?: () => () => void;
}>): DeferredStartupBackendApiContextInitializer {
  const transport = createRestrictedSessionClientTransport(params);
  const api = createRestrictedSessionBackendApi({ ...params, transport });

  return async () => Object.freeze({
    api,
    machineId: params.principal.machineId,
  });
}

function createRestrictedSessionBackendApi(params: Readonly<{
  principal: VerifiedEphemeralSessionRunnerPrincipal;
  runtimeToken: string;
  actionsSettingsProvider: RuntimeActionSettingsProvider;
  onSessionFollowInvalidated?: () => void;
  installSessionFollowWakeReceiver?: () => () => void;
  transport: SessionClientTransport;
}>): DeferredStartupBackendApi {
  return Object.freeze({
    getOrCreateSession: async () => {
      throw new EphemeralRunnerMaterializedSessionRequiredError();
    },
    sessionSyncClient: (session, options = {}) => {
      if (session.id !== params.principal.sessionId) {
        throw new Error('ephemeral_runner_session_client_scope_mismatch');
      }
      return new ApiSessionClient(params.runtimeToken, session, {
        ...options,
        transport: params.transport,
        metadataAuthority: { kind: 'shared_editor' },
        runtimePrincipalAccountId: params.principal.accountId,
        actionsSettingsProvider: params.actionsSettingsProvider,
        onSessionFollowInvalidated: params.onSessionFollowInvalidated,
        installSessionFollowWakeReceiver: params.installSessionFollowWakeReceiver,
        localMachineId: params.principal.machineId,
      });
    },
    // The Runner has no Account-wide push sender. Returning null lets the
    // shared host map this runtime to Home-required Activity delivery.
    push: () => null,
  });
}

/**
 * Ends an already materialized Runner Session through the same exact-Session
 * client and semantic Session-end owner used by the ordinary host runtime.
 * This is the pre-host-start arm of that owner, not an activation teardown.
 */
export async function terminateRestrictedMaterializedSession(params: Readonly<{
  principal: VerifiedEphemeralSessionRunnerPrincipal;
  serverId: string;
  runtimeOrigin: string;
  runtimeToken: string;
  transportEnvironment: NodeJS.ProcessEnv;
  actionsSettingsProvider: RuntimeActionSettingsProvider;
  sessionAttachSecret: SessionAttachSecret;
  workingDirectory: string;
  homeDirectory: string;
}>): Promise<void> {
  const session = await createBaseSessionForAttach({
    existingSessionId: params.principal.sessionId,
    // This pre-host client authors only semantic Session end. The attach helper
    // still requires its normal in-memory metadata fallback, which is never
    // published by this path.
    metadata: {
      path: params.workingDirectory,
      host: 'ephemeral-runner',
      homeDir: params.homeDirectory,
      happyHomeDir: params.homeDirectory,
      happyLibDir: join(params.homeDirectory, 'lib'),
      happyToolsDir: join(params.homeDirectory, 'tools'),
    },
    state: {},
    sessionAttachSecret: params.sessionAttachSecret,
  });
  const transport = createRestrictedSessionClientTransport(params);
  const api = createRestrictedSessionBackendApi({ ...params, transport });
  const client = await api.sessionSyncClient(session);
  await client.endSessionAndClose();
}
