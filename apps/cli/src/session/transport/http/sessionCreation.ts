import axios from '@/api/client/credentialAxios';
import { type AxiosResponse } from 'axios';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { decodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { classifyHomeDomainHttpMutationFailureV1, readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { AccountEncryptionCurrentnessResponse, SessionInitialAccessDraftV1, SessionManagerV1, SessionOrganizationPlacementV1, SessionTeamCredentialBindingIntentListV1, V2SessionByIdResponse } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';
import { readSessionCreationInitialTriggerError } from '@/api/session/sessionCreationInitialTriggerError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders, readCliClientUpgradeRequired } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import { resolveSessionEncryptionContext } from '@/api/client/encryptionKey';
import { resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';
import { encodeBase64 } from '@/api/encryption';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { addSessionInitialAccessTeamShareStatement, buildSessionInitialAccessCreateFields, materializeSessionInitialAccessCreateFields, prepareSessionInitialAccessDataKeyEnvelopes, readSessionTeamCredentialBindingUpdateRequiredError, readSessionInitialAccessServerError } from '@/api/session/sessionCreationInitialAccess';

/** One HTTP boundary for the API client's and seeded creator's Session birth. */
export async function postSessionCreationRequest<T>(params: Readonly<{
  serverUrl: string;
  token: string;
  body: unknown;
  creationAuthorizationToken?: string;
  /** Host-only signer for the exact birth body under its admitted Action child. */
  authorizeRequest?: (body: unknown) => Readonly<Record<string, string>>;
  /** Return the Home's exact committed-birth proof before any initial input is admitted. */
  onCreationAuthorization?: (authorization: ExternalActionExecutionAuthorizationV1) => void;
  signal?: AbortSignal;
  validateStatus?: (status: number) => boolean;
}>): Promise<AxiosResponse<T>> {
  params.signal?.throwIfAborted();
  const refuseConfirmedRollback = (status: number, data: unknown): void => {
    const rollback = readHomeDomainConfirmedRollbackV1(status, data);
    if (rollback) throw createHttpStatusError(status, 'Session creation transaction rolled back', rollback.code);
  };
  const response = await axios.post<T>(`${params.serverUrl}/v1/sessions`, params.body, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...(params.creationAuthorizationToken ? { [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: params.creationAuthorizationToken } : {}),
      ...(params.authorizeRequest ? params.authorizeRequest(params.body) : { Authorization: `Bearer ${params.token}` }),
      'Content-Type': 'application/json',
    },
    // An admitted creation operation owns its lifetime through native open.
    // Standalone callers without that lifetime retain the existing timeout.
    timeout: params.signal ? 0 : 60_000,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.validateStatus ? { validateStatus: params.validateStatus } : {}),
  }).catch((cause: unknown) => {
    // A response is handled by the existing refusal/rollback readers. Losing
    // the response after dispatch cannot prove that Session birth rolled back.
    if (axios.isAxiosError(cause) && cause.response) {
      refuseConfirmedRollback(cause.response.status, cause.response.data);
    }
    if (readHttpStatus(cause) !== null || classifyHomeDomainHttpMutationFailureV1({
      error: cause, issued: true, aborted: params.signal?.aborted === true,
    }) !== 'outcome_unknown') throw cause;
    throw Object.assign(new Error('Session creation outcome is unknown; reconcile the original creation key before retrying'), {
      code: 'outcome_unknown' as const,
      cause: { ...serializeAxiosErrorForLog(cause), code: readNormalizedConnectionErrorCode(cause) },
    });
  });
  refuseConfirmedRollback(response.status, response.data);
  // Cancellation cannot undo a remote commit, but it cannot report success to
  // an invocation that has already retired either.
  params.signal?.throwIfAborted();
  if (response.status === 200 && params.onCreationAuthorization) {
    const value = response.headers?.[TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1];
    if (value !== undefined) {
      const authorization = typeof value === 'string' ? decodeTemplateBirthExecutionAuthorizationV1(value) : null;
      if (!authorization) throw new Error('Unexpected /v1/sessions birth authorization shape');
      params.onCreationAuthorization(authorization);
    }
  }
  return response;
}

export async function getOrCreateSessionByTag(params: Readonly<import('@happier-dev/protocol').SessionCreateOriginFieldsV1 & {
  credentials: StoredCredentials;
  tag: string;
  metadata: Record<string, unknown>;
  agentState: Record<string, unknown> | null;
  currentStorageState?: 'machine_only';
  organizationPlacement?: SessionOrganizationPlacementV1;
  shouldCommit?: () => boolean;
  initialAccess?: SessionInitialAccessDraftV1;
  initialTriggers?: readonly import('@happier-dev/protocol').SessionInitialTriggerAdmissionV1[];
  manager?: SessionManagerV1;
  primaryTeamId?: string | null;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
  creationAuthorizationToken?: string;
  authorizeRequest?: Parameters<typeof postSessionCreationRequest>[0]['authorizeRequest'];
  templateRequesterAuthorization?: Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    originalActionEnvelope: ExternalActionRequestEnvelope;
  }>;
  onCreationAuthorization?: Parameters<typeof postSessionCreationRequest>[0]['onCreationAuthorization'];
  prepareCreationAuthorizationProof?: import('@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1').SessionCreationAuthorizationV1['prepareRequestProof'];
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  signal?: AbortSignal;
}>): Promise<{
  session: V2SessionByIdResponse['session'];
  created: boolean;
  creationConfirmed: boolean;
  organizationPlacement?: SessionOrganizationPlacementV1;
}> {
  const serverUrl = resolveServerHttpBaseUrl();

  const encryptionModeResolution = await resolveSessionCreateEncryptionMode({
    token: params.credentials.token,
    serverBaseUrl: serverUrl,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.accountEncryptionCurrentness
      ? { accountEncryptionCurrentness: params.accountEncryptionCurrentness }
      : {}),
  });
  if (encryptionModeResolution.status === 'currentness_unavailable') {
    const { error } = encryptionModeResolution;
    // Match ApiClient's stable auth refusal while preserving the currentness
    // phase for every other failure before the Session request is issued.
    if (isAuthenticationStatus(readHttpStatus(error.cause ?? error))) throw error.cause ?? error;
    throw error;
  }
  const {
    desiredSessionEncryptionMode,
    accountEncryptionCurrentness,
    serverSupportsFeatureSnapshot,
    serverFeaturesSnapshot,
  } = encryptionModeResolution;

  const initialAccessFields = buildSessionInitialAccessCreateFields(params, serverFeaturesSnapshot);
  const creationMetadata = addSessionInitialAccessTeamShareStatement(params.metadata, initialAccessFields, desiredSessionEncryptionMode);
  const sessionEncryptionContext =
    desiredSessionEncryptionMode === 'e2ee'
      ? await resolveSessionEncryptionContext(params.credentials)
      : null;
  const metadataEnvelopeFields =
    desiredSessionEncryptionMode === 'plain'
      ? buildSessionMetadataEnvelopeCreateFields({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          metadata: creationMetadata,
          agentState: params.agentState,
          storedContentMode: 'plain',
        })
      : (() => {
          if (!sessionEncryptionContext) {
            throw new Error('Session encryption context is unavailable');
          }
          return buildSessionMetadataEnvelopeCreateFields({
            credentials: params.credentials,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
            metadata: creationMetadata,
            agentState: params.agentState,
            storedContentMode: 'e2ee',
            encryptionKey: sessionEncryptionContext.encryptionKey,
            encryptionVariant: sessionEncryptionContext.encryptionVariant,
          });
        })();
  const dataEncryptionKeyPayload =
    sessionEncryptionContext?.dataEncryptionKey
      ? encodeBase64(sessionEncryptionContext.dataEncryptionKey)
      : null;
  const materializedInitialAccessFields = await materializeSessionInitialAccessCreateFields({
    fields: initialAccessFields,
    sessionEncryptionMode: desiredSessionEncryptionMode,
    sessionDataKey: sessionEncryptionContext?.encryptionVariant === 'dataKey'
      ? sessionEncryptionContext.encryptionKey
      : null,
    token: params.credentials.token,
    serverHttpBaseUrl: serverUrl,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (params.shouldCommit && !params.shouldCommit()) {
    throw new Error('Session creation commit precondition failed');
  }
  const body = {
    ...(params.templateRequesterAuthorization ? { templateRequesterAuthorization: params.templateRequesterAuthorization } : {}),
    ...pickSessionCreateOriginFields(params),
    ...(params.manager !== undefined ? { manager: params.manager } : {}),
    tag: params.tag,
    ...metadataEnvelopeFields,
    dataEncryptionKey: dataEncryptionKeyPayload,
    ...(params.currentStorageState ? { currentStorageState: params.currentStorageState } : {}),
      ...(params.organizationPlacement ? { organizationPlacement: params.organizationPlacement } : {}),
      ...(params.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
    ...materializedInitialAccessFields,
    ...(params.initialTriggers !== undefined ? { initialTriggers: params.initialTriggers } : {}),
    ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
  };
  const creationAuthorizationProof = await params.prepareCreationAuthorizationProof?.(body);
  const response = await postSessionCreationRequest<unknown>({
    serverUrl,
    token: params.credentials.token,
    body: { ...body, ...(creationAuthorizationProof ? { creationAuthorizationProof } : {}) },
    ...(params.creationAuthorizationToken ? { creationAuthorizationToken: params.creationAuthorizationToken } : {}),
    ...(params.authorizeRequest ? { authorizeRequest: params.authorizeRequest } : {}),
    ...(params.onCreationAuthorization ? { onCreationAuthorization: params.onCreationAuthorization } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  const initialTriggerError = readSessionCreationInitialTriggerError(response.data, response.status);
  if (initialTriggerError) throw initialTriggerError;
  const initialAccessServerError = response.status === 200
    ? null
    : readSessionInitialAccessServerError(response.data, response.status);
  if (initialAccessServerError) throw initialAccessServerError;
  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, `Unauthorized (${response.status})`);
  }
  if (response.status === 426) {
    const upgradeRequired = readCliClientUpgradeRequired(response.data);
    if (
      upgradeRequired?.requirement
      && 'kind' in upgradeRequired.requirement
      && upgradeRequired.requirement.kind === 'account-stored-content'
    ) {
      throw Object.assign(
        new Error('Session creation requires a stored-content-compatible server'),
        {
          code: 'client-upgrade-required' as const,
          retryable: false as const,
          requirement: upgradeRequired.requirement,
        },
      );
    }
  }
  if (response.status !== 200) {
    const teamCredentialUpdateRequired = readSessionTeamCredentialBindingUpdateRequiredError(response.data);
    if (teamCredentialUpdateRequired) throw teamCredentialUpdateRequired;
    throw new Error(`Unexpected status from /v1/sessions: ${response.status}`);
  }

  const admission = V2SessionByIdResponseSchema.safeParse(response.data);
  if (!admission.success) throw new Error('Unexpected /v1/sessions response shape');
  const parsed = admission.data;
  if (!parsed || !parsed.session || typeof parsed.session !== 'object') {
    throw new Error('Unexpected /v1/sessions response shape');
  }
  const returnedMode = resolveSessionStoredContentEncryptionMode(parsed.session);
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(returnedMode);
  await prepareSessionInitialAccessDataKeyEnvelopes({
    fields: initialAccessFields,
    sessionId: parsed.session.id,
    sessionEncryptionMode: returnedMode,
    credentials: params.credentials,
    session: parsed.session,
    token: params.credentials.token,
    serverHttpBaseUrl: serverUrl,
    ...(params.shouldCommit ? { isScopeCurrent: params.shouldCommit } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  // Released and predecessor servers omit `created`; preserve their historical
  // create-or-load behavior while current servers report the exact race result.
  return {
    session: parsed.session,
    created: parsed.created !== false,
    creationConfirmed: parsed.created === true,
    ...(parsed.organizationPlacement
      ? { organizationPlacement: parsed.organizationPlacement }
      : {}),
  };
}
