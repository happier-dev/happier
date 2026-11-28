import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildSessionSpawnNewArgs } from '@happier-dev/protocol/actions/executor/sessionSpawn';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SESSION_SPAWN_GUEST_RECONNECTED_WITHOUT_BIRTH,
  type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';

import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { lookupSessionsByTags } from '@/session/transport/http/sessionsHttp';

/** Observe only the original request's immutable, committed birth. */
export async function observeExternalSessionBirth(params: Readonly<{
  credentials: StoredCredentials;
  actionInput: unknown;
  context: ActionExecutorContext;
}>): Promise<SessionSpawnNewResultV1 | null> {
  const { credentials, context } = params;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const actionInput = SessionSpawnNewActionInputV2Schema.safeParse(params.actionInput);
  if (binding?.actionId !== 'session.spawn_new' || binding.accountEncryptionMode === undefined || !actionInput.success) return null;
  const target = actionInput.data.executionTarget ?? { serverId: binding.serverIdentityId, machineId: binding.machineId };
  const args = buildSessionSpawnNewArgs({ ...actionInput.data, executionTarget: target }, context);
  const tag = args?.sessionCreationTag;
  if (!tag || target.machineId !== binding.machineId) return null;

  const lookup = await lookupSessionsByTags({ token: credentials.token, tags: [tag], signal: context.signal });
  if (lookup.state !== 'available' || lookup.sessions.length > 1) return null;
  const session = lookup.sessions[0];
  if (!session) {
    return {
      type: 'error',
      code: 'spawn_failed',
      retryable: true,
      failureCause: readActionFailureCauseV1({ phase: 'session.creation', errorClass: 'Error',
        errorCode: 'spawn_failed', nativeErrorReason: SESSION_SPAWN_GUEST_RECONNECTED_WITHOUT_BIRTH, httpStatus: null }),
    };
  }

  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials, rawSession: session, accountEncryptionMode: binding.accountEncryptionMode,
  });
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(metadata?.sessionCreationCorrespondenceV1);
  if (!correspondence.success || correspondence.data.sessionCreationTag !== tag
    || correspondence.data.recipe.execution.machineId !== binding.machineId
    || correspondence.data.externalActionRequestDigest !== binding.requestEnvelopeDigest) return null;

  const localId = actionInput.data.initialInput ? buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: tag }) : null;
  if (actionInput.data.initialInput && !localId) return null;
  const placement = actionInput.data.sessionPlacement;
  if (localId && placement?.kind === 'machine' && placement.configuredSandbox
    && session.active === false && session.seq === 0 && session.runtimeActivityRevision === 0) {
    // Birth is committed. The runner and first input still belong to the original launch.
    return { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true, sessionId: session.id };
  }
  return {
    type: 'success',
    disposition: 'rejoined',
    sessionId: session.id,
    executionTarget: target,
    organizationPlacement: correspondence.data.recipe.organization,
    initialInput: localId
      ? { status: 'outcomeUnknown', localId, code: 'outcome_unknown' }
      : { status: 'notRequested' },
  };
}
