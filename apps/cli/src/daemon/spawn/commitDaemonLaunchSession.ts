import { randomUUID } from 'node:crypto';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';
import { pickDefinedSpawnSessionOptions, SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';

import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';

import type { ApiClient } from '@/api/api';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import type { SessionCreationOutcome } from '@/api/types';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { StoredCredentials } from '@/persistence';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { archiveSessionOnceInactive } from '@/session/services/archiveSessionOnceInactive';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
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
  if (!options.existingSessionId && (options.discussionParticipant !== undefined
    || options.sessionCreationCorrespondence?.recipe.discussionParticipant !== undefined)) {
    // Typed native callers share the raw owner's fresh-origin correspondence
    // and no-initial-work admission; never infer omitted birth authority.
    SpawnDaemonSessionRequestSchema.parse(pickDefinedSpawnSessionOptions(options));
    return true;
  }
  if (options.workspaceWrites !== undefined) return true;
  if (options.capabilitySelection !== undefined) return true;
  if (options.requesterSessionBootstrap) return true;
  if ((options.promptStack?.length ?? 0) > 0) return true;
  if (options.creationAuthorization || options.initialSessionRolesV1 || (options.initialTriggers?.length ?? 0) > 0) return true;
  if (options.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model' && binding.resourceId !== null)) return true;
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
  releaseNativeBindingOnLaunchFailure?: () => Promise<void>;
}>;

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
  accountSettings?: Readonly<Record<string, unknown>>;
  prepareNativeTeamCredentialBinding?: (input: Readonly<{
    sessionId: string;
    created: boolean;
    binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
  }>) => Promise<() => Promise<void>>;
}>): Promise<
  | Readonly<{ ok: true; session: CommittedDaemonLaunchSession }>
  | Readonly<{ ok: false; result: SpawnError }>
> {
  const { options } = input;
  const tag = options.sessionCreationTag
    ? SessionCreationTagV1Schema.parse(options.sessionCreationTag)
    : randomUUID();
  const mintedIdentity = resolveConnectedServiceMaterializationIdentityForSpawn({ options });
  const accountSettings = input.accountSettings ?? await resolveAvailableAccountSettings({ credentials: input.credentials });
  let created: Awaited<ReturnType<ApiClient['getOrCreateSession']>>;
  try {
    created = await input.api.getOrCreateSession({
      ...pickSessionCreateOriginFields(options),
      ...(options.projectSetupOperation ? { signal: options.projectSetupOperation.signal } : {}),
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
        ...(accountSettings ? { accountSettings } : {}),
      }),
      state: { controlledByUser: false },
      ...(options.initialAccess !== undefined ? { initialAccess: options.initialAccess } : {}),
      ...(options.initialTriggers !== undefined ? { initialTriggers: options.initialTriggers } : {}),
      ...(options.manager !== undefined ? { manager: options.manager } : {}),
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
        // The API's null result means offline mode, including a pre-create
        // currentness failure. It is not a negative Session-create receipt.
        errorMessage: 'Unable to start the Agent because the Happier server is unreachable (offline).',
      },
    };
  }
  const attach = await resolveExistingSessionAttachContext({
    token: input.credentials.token,
    sessionId: created.id,
    credentials: input.credentials,
  });
  const createdHere = created.sessionCreationOutcome?.disposition === 'created';
  const requestedTeamModel = options.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model' && binding.resourceId !== null);
  const acceptedTeamModel = attach.ok ? attach.attachPayload.snapshot?.acceptedTeamCredentialBinding : null;
  const missingTeamModelWitness = requestedTeamModel && (!acceptedTeamModel
    || acceptedTeamModel.slot.kind !== 'provider_model' || acceptedTeamModel.resourceId === null);
  if (!attach.ok || missingTeamModelWitness) {
    if (createdHere) {
      await archiveSessionOnceInactive({ token: input.credentials.token, sessionId: created.id })
        .catch(() => undefined);
    }
    return { ok: false, result: !attach.ok ? mapExistingSessionAttachFailureToSpawnError(attach) : {
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'team_credential_provider_binding_unavailable',
    } };
  }

  // The accepted birth witness exists now, but no caller has yet observed the
  // committed Session. Keep genuine spawn custody through its exact first
  // native install before acceptance may retire the ingress or launch Agent work.
  let releaseNativeBindingOnLaunchFailure: (() => Promise<void>) | undefined;
  if (acceptedTeamModel?.resourceId && acceptedTeamModel.deliveryMode === 'vendor-native') {
    if (!input.prepareNativeTeamCredentialBinding) throw new SessionTeamCredentialLaunchUnavailableError();
    releaseNativeBindingOnLaunchFailure = await input.prepareNativeTeamCredentialBinding({ sessionId: created.id, created: createdHere, binding: acceptedTeamModel });
  }

  // The same operation continues launch, native open and original-input admission.
  // Only its individually opted-in observers can receive this committed proof.
  const acceptance = options.projectSetupOperation?.operationAcceptance;
  if (acceptance?.actionId === 'session.spawn_new') {
    acceptance.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', sessionId: created.id });
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
      ...(releaseNativeBindingOnLaunchFailure ? { releaseNativeBindingOnLaunchFailure } : {}),
      sessionId: created.id,
      created: createdHere,
      ...(created.sessionCreationOutcome
        ? { sessionCreationOutcome: created.sessionCreationOutcome }
        : {}),
      attachPayload: attach.attachPayload,
      options: {
        ...optionsWithoutIdentity,
        existingSessionId: created.id,
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
    initialTitle: _initialTitle,
    authoringOrigin: _authoringOrigin,
    identity: _initialIdentity,
    memoryEnabled: _initialMemoryEnabled,
    promptStack: _initialPromptStack,
    manager: _manager,
    initialSessionRolesV1: _initialSessionRolesV1,
    originKind: _originKind,
    originSessionId: _originSessionId,
    originRunId: _originRunId,
    discussionParticipant: _discussionParticipant,
    discussionParticipantLaunch: _discussionParticipantLaunch,
    workDepth: _workDepth,
    primaryTeamId: _primaryTeamId,
    teamCredentialBindings: _teamCredentialBindings,
    creationAuthorization: _creationAuthorization,
    ...attachOptions
  } = options;
  return attachOptions;
}
