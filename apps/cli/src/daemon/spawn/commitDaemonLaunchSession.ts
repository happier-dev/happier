import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';

import {
  parseSessionMcpSelectionV1Json,
  SessionCreationTagV1Schema,
  SessionRolesV1Schema,
  type ConnectedServiceMaterializationIdentityV1,
  type SessionMetadata,
} from '@happier-dev/protocol';
import { applyAcpSessionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { ApiClient } from '@/api/api';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import type { SessionCreationOutcome } from '@/api/types';
import { parseSessionMetadataConfigOptionOverridesJson } from '@/agent/runtime/compat/sessionMetadataOverrides';
import { applySessionConfigOptionOverridesToMetadata } from '@/agent/runtime/createSessionMetadata';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { StoredCredentials } from '@/persistence';
import { archiveSessionOnceInactive } from '@/session/services/archiveSessionOnceInactive';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';

import {
  readConnectedServiceMaterializationIdentityFromMetadata,
  resolveConnectedServiceMaterializationIdentityForSpawn,
} from '../connectedServices/materialization/identity';
import { ConnectedServicesBindingsIngressSchema } from '../connectedServices/parseConnectedServicesBindings';
import { resolveExistingSessionAttachContext } from '../sessionEncryption/resolveExistingSessionAttachContext';
import { buildSessionCreationTerminalSpawnErrorResult } from '../sessions/onHappySessionWebhook';
import { mapExistingSessionAttachFailureToSpawnError } from './resolveSpawnBackendIdentity';

type SpawnError = Extract<SpawnSessionResult, { type: 'error' }>;

/**
 * A fresh launch whose connected services select Team material delivered
 * directly needs its Session before launch material is opened: the Home
 * discloses direct material only to an existing Session consumer carrying its
 * own accepted Team binding (lane 10 child 06 L10D-R11, §15; child 01
 * principle 3). Resolved role snapshots also commit here so complete role text
 * reaches the runner through its existing protected attach file, without an
 * operating-system environment-size boundary. Initial triggers commit with
 * their Session before the runner starts. Other fresh launches keep
 * runner-side creation.
 */
export function daemonLaunchRequiresCommittedSession(options: SpawnSessionOptions): boolean {
  if (options.creationAuthorization || options.initialSessionRolesV1 || (options.initialTriggers?.length ?? 0) > 0) return true;
  const admitted = ConnectedServicesBindingsIngressSchema.safeParse(options.connectedServices);
  if (!admitted.success || !admitted.data) return false;
  return Object.values(admitted.data.bindingsByServiceId).some((binding) => (
    binding.source === 'team_resource' && binding.deliveryMode === 'direct'
  ));
}

export type CommittedDaemonLaunchSession = Readonly<{
  sessionId: string;
  /** True only when the Home reported this call created the row; a launch refused before start archives only such a row. */
  created: boolean;
  sessionCreationOutcome?: SessionCreationOutcome;
  attachPayload: SessionAttachFilePayload;
  /** The launch continues as an attach to this Session with these options. */
  options: SpawnSessionOptions;
}>;

/**
 * Seeds the launch intents an attaching runner never takes from its own
 * process (`mergeSessionMetadataForStartup` attach safety): the requested
 * session mode, configuration overrides and MCP selection. Permission mode and
 * model arrive as runner startup overrides; every other runtime field is the
 * runner's own, applied on attach with `replace_with_runtime_identity`.
 */
function buildCommittedLaunchMetadata(input: Readonly<{
  options: SpawnSessionOptions;
  directory: string;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1;
}>): SessionMetadata {
  const { options } = input;
  const mcpSelection = options.mcpSelection
    ? parseSessionMcpSelectionV1Json(JSON.stringify(options.mcpSelection))
    : null;
  let metadata: SessionMetadata = {
    path: input.directory,
    host: os.hostname(),
    ...(options.sessionCreationCorrespondence
      ? { sessionCreationCorrespondenceV1: options.sessionCreationCorrespondence }
      : {}),
    ...(options.placementOrigin ? { placementOrigin: options.placementOrigin } : {}),
    ...(options.runtimeDescriptorV1 ? { runtimeDescriptorV1: options.runtimeDescriptorV1 } : {}),
    ...(mcpSelection ? { mcpSelectionV1: mcpSelection } : {}),
    connectedServiceMaterializationIdentityV1: input.materializationIdentity,
    ...(options.initialSessionRolesV1 ? { work: { sessionRolesV1: SessionRolesV1Schema.parse(options.initialSessionRolesV1) } } : {}),
  };
  const agentModeId = input.agentModeId?.trim();
  if (agentModeId) {
    metadata = applyAcpSessionModeIntentSessionMetadata(metadata, {
      v: 1,
      modeId: agentModeId,
      updatedAt: input.agentModeUpdatedAt ?? Date.now(),
    });
  }
  return applySessionConfigOptionOverridesToMetadata(
    metadata,
    options.sessionConfigOptionOverrides
      ? parseSessionMetadataConfigOptionOverridesJson(JSON.stringify(options.sessionConfigOptionOverrides))
      : null,
  );
}

/**
 * Commits a fresh daemon launch's Session through the runner's own
 * create-or-load owner (`ApiClient.getOrCreateSession`, keyed by the launch's
 * creation tag) with its initial access, primary Team and Team slot bindings,
 * so the Home writes the accepted binding in the create transaction. The runner
 * then attaches to that exact Session, as to any existing Session.
 */
export async function commitDaemonLaunchSession(input: Readonly<{
  api: Pick<ApiClient, 'getOrCreateSession'>;
  credentials: StoredCredentials;
  options: SpawnSessionOptions;
  directory: string;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
}>): Promise<
  | Readonly<{ ok: true; session: CommittedDaemonLaunchSession }>
  | Readonly<{ ok: false; result: SpawnError }>
> {
  const { options } = input;
  const tag = options.sessionCreationTag
    ? SessionCreationTagV1Schema.parse(options.sessionCreationTag)
    : randomUUID();
  const mintedIdentity = resolveConnectedServiceMaterializationIdentityForSpawn({ options });
  let created: Awaited<ReturnType<ApiClient['getOrCreateSession']>>;
  try {
    created = await input.api.getOrCreateSession({
      ...pickSessionCreateOriginFields(options),
      tag,
      ...(options.creationAuthorization ? { creationAuthorizationToken: options.creationAuthorization.token } : {}),
      metadata: buildCommittedLaunchMetadata({
        options,
        directory: input.directory,
        ...(input.agentModeId ? { agentModeId: input.agentModeId } : {}),
        ...(typeof input.agentModeUpdatedAt === 'number'
          ? { agentModeUpdatedAt: input.agentModeUpdatedAt }
          : {}),
        materializationIdentity: mintedIdentity,
      }),
      state: { controlledByUser: false },
      ...(options.initialAccess !== undefined ? { initialAccess: options.initialAccess } : {}),
      ...(options.initialTriggers !== undefined ? { initialTriggers: options.initialTriggers } : {}),
      ...(options.reportsTo !== undefined ? { reportsTo: options.reportsTo } : {}),
      ...(options.primaryTeamId !== undefined ? { primaryTeamId: options.primaryTeamId } : {}),
      ...(options.teamCredentialBindings !== undefined
        ? { teamCredentialBindings: options.teamCredentialBindings }
        : {}),
      ...(options.sessionCreationCorrespondence
        ? { organizationPlacement: options.sessionCreationCorrespondence.recipe.organization }
        : {}),
    });
  } catch (error) {
    const errorDetail = readSessionCreationTerminalSpawnErrorDetail(error);
    if (errorDetail) return { ok: false, result: buildSessionCreationTerminalSpawnErrorResult(errorDetail) };
    throw error;
  }
  if (!created) {
    return {
      ok: false,
      result: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'Unable to start the Agent because the Happier server did not create a durable Session.',
      },
    };
  }
  const attach = await resolveExistingSessionAttachContext({
    token: input.credentials.token,
    sessionId: created.id,
    credentials: input.credentials,
  });
  const createdHere = created.sessionCreationOutcome?.disposition === 'created';
  if (!attach.ok) {
    if (createdHere) {
      await archiveSessionOnceInactive({ token: input.credentials.token, sessionId: created.id })
        .catch(() => undefined);
    }
    return { ok: false, result: mapExistingSessionAttachFailureToSpawnError(attach.reason) };
  }

  const rejoined = !createdHere;
  // A rejoined Session keeps the identity its first launch persisted; without
  // one, the existing-Session identity owner repairs or refuses it.
  const identity = rejoined
    ? readConnectedServiceMaterializationIdentityFromMetadata(created.metadata)
    : mintedIdentity;
  const {
    connectedServiceMaterializationIdentityV1: _requestedIdentity,
    ...optionsWithoutIdentity
  } = options;
  return {
    ok: true,
    session: {
      sessionId: created.id,
      created: createdHere,
      ...(created.sessionCreationOutcome
        ? { sessionCreationOutcome: created.sessionCreationOutcome }
        : {}),
      attachPayload: attach.attachPayload,
      options: {
        ...optionsWithoutIdentity,
        ...(identity ? { connectedServiceMaterializationIdentityV1: identity } : {}),
        attachMetadataIdentityPolicy: options.attachMetadataIdentityPolicy ?? 'replace_with_runtime_identity',
      },
    },
  };
}

/** Launch options for the runner attaching to a committed Session. */
export function withoutFreshSessionCreationFields(options: SpawnSessionOptions): SpawnSessionOptions {
  const {
    initialAccess: _initialAccess,
    initialTriggers: _initialTriggers,
    reportsTo: _reportsTo,
    initialSessionRolesV1: _initialSessionRolesV1,
    originKind: _originKind,
    originSessionId: _originSessionId,
    originRunId: _originRunId,
    workDepth: _workDepth,
    primaryTeamId: _primaryTeamId,
    teamCredentialBindings: _teamCredentialBindings,
    creationAuthorization: _creationAuthorization,
    ...attachOptions
  } = options;
  return attachOptions;
}
