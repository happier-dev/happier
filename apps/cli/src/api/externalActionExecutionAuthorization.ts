import axios from 'axios';
import { randomBytes } from 'node:crypto';

import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionMachineRpcExecutionV1, ExternalActionRequestEnvelope, ExternalActionTargetV1 } from '@happier-dev/protocol';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionHttpErrorSchema, ExternalActionResponseEnvelopeV1Schema, isExternalActionSubmittedUnknownHttpResponse, projectExternalActionPendingResetStartAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, openExternalActionResponseV2, sealExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ProjectServiceRelocateInputV1Schema, isProjectServiceMoveChildInputV1, readProjectServiceMoveChildEffectV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { DaemonLocalServiceLauncherStartRequestV1Schema, DaemonLocalServiceLauncherSnapshotRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ExternalActionExecutionAuthorizationRequestV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { assertResolvedHomeTargetIdentity } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { listCurrentAccountMachines, type CurrentAccountMachineInventoryItem } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';
import { ExternalActionSignedAuthenticationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AUTHORITY_CEILING_HEADER_V1, resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { z } from 'zod/mini';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectRequesterSessionCredentialDisclosure, sealExternalActionRequesterAccountContextV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials } from '@/persistence';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { isMachineTerminalActionId } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { ManagedWakeTargetV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MachineEnvironmentApplyInputV1Schema, MANAGED_CONTROL_ACTION_IDS_V1, type MachineEnvironmentApplyInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { refuseExternalActionPhase, traceExternalActionInnerStage, runTracedExternalActionInnerStage, readSessionInputAdmissionDiagnostic } from '@/daemon/externalActions/externalActionPhase';
import { projectExternalActionRunNowIdempotencyKeyV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { readDiscussionSecondOpinionModelChildV1, isDiscussionSecondOpinionModelRpcMethodV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { DiscussionDetailsResponseV1Schema, DiscussionListResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { buildDiscussionModelSessionCreationProofPayloadV1, type SessionCreationAuthorizationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';

export type ExternalActionMachineRequestSigningKey = string | Uint8Array;

/** A retained root is opened only with its admitted requester's material. */
async function readReviewedExternalActionInput(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal?: AbortSignal;
}>) {
  const binding = input.authorization.binding;
  const envelope = ExternalActionRequestEnvelopeSchema.safeParse(input.envelope);
  const requester = readRequesterAccountActionContext(input.authorization);
  if (!envelope.success || !requester || input.signal?.aborted
    || !await requester.isCurrent() || !isExternalActionAuthorizationBoundToEnvelope(binding,
      { actionId: binding.actionId, machineId: binding.machineId, envelope: envelope.data })) return null;
  let value: unknown = envelope.data.v === 1 ? envelope.data.input : undefined;
  if (envelope.data.v === 2) {
    const encryption = await requester.resolveEncryption(input.signal);
    if (encryption?.serverIdentityId !== binding.serverIdentityId) return null;
    value = openExternalActionRequestV2({ envelope: envelope.data, material: encryption.material, binding: {
      serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, actionId: binding.actionId,
      requestId: binding.requestId, target: binding.target,
      ...('authentication' in binding ? { authentication: { kind: binding.authentication.kind,
        tokenEpoch: binding.authentication.tokenEpoch } } : { credentialId: binding.credentialId }),
    } })?.input;
  }
  return !input.signal?.aborted && await requester.isCurrent() ? value : null;
}

/** The unchanged Move envelope is opened only with its admitted requester's material. */
export async function readReviewedServiceMoveInput(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal?: AbortSignal;
}>) {
  if (input.authorization.binding.actionId !== 'projects.service.relocate') return null;
  const parsed = ProjectServiceRelocateInputV1Schema.safeParse(await readReviewedExternalActionInput(input));
  return parsed.success && parsed.data.workspace.serverId === input.authorization.binding.serverIdentityId ? parsed.data : null;
}

/** A source signature alone never authorizes arbitrary Session creation at another installation. */
export async function isReviewedSecondOpinionModelSpawnChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; method?: string; signal?: AbortSignal;
}>): Promise<boolean> {
  if (input.authorization.binding.actionId !== 'discussion.second_opinion.start' || input.actionId !== 'session.spawn_new') return false;
  const wrapper = TargetedActionRpcRequestV1Schema.safeParse(input.params);
  const derived = readDiscussionSecondOpinionModelChildV1(await readReviewedExternalActionInput(input),
    input.machineId, wrapper.success ? wrapper.data.input : input.params, input.method);
  const requester = readRequesterAccountActionContext(input.authorization);
  const serverId = input.authorization.requesterAccountProjection?.serverId;
  if (!derived || !requester || !serverId || derived.spawn && !await isServerProfileHomeIdentity(serverId, derived.spawn.executionTarget.serverId)
    || !await isServerProfileHomeIdentity(serverId, derived.launch.executionTarget.serverId)) return false;
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${requester.credentials.token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' };
  const read = async (path: string) => {
    if (input.signal?.aborted || !await requester.isCurrent()) return null;
    const response = await axios.get<unknown>(`${normalizeServerHttpBaseUrl(requester.serverHttpBaseUrl)}${path}`, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 300 && !input.signal?.aborted && await requester.isCurrent() ? response.data : null;
  };
  try {
    const restored = derived.spawn ? null : DiscussionListResponseV1Schema.safeParse(await read(
      `/v1/discussions?creationLocalId=${encodeURIComponent(derived.root.retry.creationLocalId)}`));
    const discussionId = derived.spawn?.discussionParticipant?.discussionId
      ?? (restored?.success && restored.data.discussions.length === 1 ? restored.data.discussions[0]?.id : undefined);
    if (!discussionId) return false;
    const resource = DiscussionDetailsResponseV1Schema.safeParse(await read(`/v1/discussions/${encodeURIComponent(discussionId)}`));
    if (!resource.success || resource.data.discussion.id !== discussionId || resource.data.discussion.archivedAt !== null
      || resource.data.discussion.ownerAccountId !== input.authorization.binding.accountId
      || resource.data.discussion.creationLocalId !== derived.root.retry.creationLocalId) return false;
    const roster = DiscussionParticipantsListResponseV1Schema.safeParse(await read(`/v1/discussions/${encodeURIComponent(discussionId)}/participants`));
    if (!roster.success || roster.data.discussionId !== discussionId || roster.data.ownerAccountId !== input.authorization.binding.accountId) return false;
    const slot = roster.data.participants.find(participant => participant.participant.kind === 'model'
      && participant.participant.participantSlotId === derived.reviewer.participantSlotId);
    if (!slot || !('launch' in slot) || slot.answerPolicy !== 'when_addressed') return false;
    return sameStrictJsonValue({ ...slot.launch, executionTarget: { ...slot.launch.executionTarget,
      serverId: derived.launch.executionTarget.serverId } }, derived.launch)
      && !input.signal?.aborted && await requester.isCurrent();
  } catch (error) { rethrowRequesterHomeReadFailure(error); return false; }
}

/** Only the reached native receiver may bind the reviewed public child to its final HTTP birth body. */
export function createReviewedSecondOpinionSessionCreationAuthorization(input: Readonly<{
  context: ActionExecutorContext & Partial<Pick<RpcHandlerContext, 'workspaceSyncSourceExecution' | 'machineAdmission' | 'verifyMachineAdmissionCurrent'>>;
  publicInput: SessionSpawnNewInputV2;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): SessionCreationAuthorizationV1 | null {
  const authorization = input.context.externalActionExecutionAuthorization;
  if (authorization?.binding.actionId !== 'discussion.second_opinion.start') return null;
  const sourceExecution = input.context.workspaceSyncSourceExecution;
  const machineAdmission = input.context.machineAdmission;
  const ref = input.publicInput.discussionParticipant;
  if (!sourceExecution || !machineAdmission || !ref || !input.context.verifyMachineAdmissionCurrent
    || sourceExecution.method !== `${machineAdmission.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`
    || machineAdmission.machineId !== input.publicInput.executionTarget.machineId
    || machineAdmission.installationId !== input.installationId
    || sourceExecution.externalActionExecution.authorization.token !== authorization.token
    || !sameStrictJsonValue(sourceExecution.externalActionExecution.authorization.binding, authorization.binding)
    || !sameStrictJsonValue(sourceExecution.originalActionEnvelope, input.context.originalActionEnvelope)) return null;
  return { token: authorization.token, prepareRequestProof: async body => {
    if (!await input.context.verifyMachineAdmissionCurrent!()
      || !await isReviewedSecondOpinionModelSpawnChild({ authorization, envelope: input.context.originalActionEnvelope,
        machineId: machineAdmission.machineId, actionId: 'session.spawn_new', params: input.publicInput,
        ...(input.context.signal ? { signal: input.context.signal } : {}) })
      || body.originKind !== 'discussion' || !sameStrictJsonValue(body.discussionParticipant, ref)
      || !sameStrictJsonValue(body.discussionParticipantLaunch, projectDiscussionModelParticipantLaunchV1(input.publicInput))
      || body.tag !== deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['discussion-participant', ref.discussionId]),
        creationKey: ref.participantSlotId })) throw new Error('discussion_model_creation_authorization_unavailable');
    return { v: 1, sourceExecution, machineAdmission,
      proof: signMachineInstallationProof({ privateKey: input.privateKey,
        payload: buildDiscussionModelSessionCreationProofPayloadV1({ sourceExecution, machineAdmission, body }) }) };
  } };
}

/** Exact current Account refs constrain the two child reads/starts that carry a root path. */
export async function isReviewedServiceMoveChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; signal?: AbortSignal;
}>): Promise<boolean> {
  const move = await readReviewedServiceMoveInput(input);
  if (!move || !isProjectServiceMoveChildInputV1(move, input.actionId, input.machineId, input.params)) return false;
  if (input.actionId !== 'localServices.launcher.start' && input.actionId !== 'localServices.launcher.snapshot'
    && input.actionId !== 'projects.inspect') return true;
  const requester = readRequesterAccountActionContext(input.authorization);
  if (!requester) return false;
  const { readWorkspaceSyncWorkerTargetSnapshot, resolveWorkspaceSyncWorkerTarget } = await import('@/workspaces/sync/workspaceSyncPreparation');
  const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({ serverId: move.workspace.serverId,
    serverHttpBaseUrl: requester.serverHttpBaseUrl, credentials: requester.credentials, authorization: input.authorization,
    sourceWorkspaceRefId: move.workspace.refId, targetMachineId: input.machineId, signal: input.signal });
  const wrapper = TargetedActionRpcRequestV1Schema.safeParse(input.params);
  const value = wrapper.success ? wrapper.data.input : input.params;
  if (input.actionId === 'projects.inspect') {
    const { ProjectDefinitionInspectInputSchema } = await import('@happier-dev/protocol/actions/projectDefinitionActionFamily');
    const inspection = ProjectDefinitionInspectInputSchema.parse(value);
    const destination = resolveWorkspaceSyncWorkerTarget({ serverId: move.workspace.serverId, sourceWorkspaceRefId: move.workspace.refId,
      targetMachineId: move.selectedTarget.machineId, workspaceRefs: snapshot.workspaceRefs,
      relationships: snapshot.relationships, childMachines: snapshot.childMachines });
    const source = snapshot.workspaceRefs.find(ref => ref.id === move.workspace.refId && ref.serverId === move.workspace.serverId);
    return [source, ...(destination.ok ? [destination.target] : [])].some(ref => ref
      && ref.machineId === input.machineId && inspection.workspace.workspaceId === ref.id
      && inspection.workspace.rootPath === ref.rootPath) && await requester.isCurrent();
  }
  if (input.actionId === 'localServices.launcher.snapshot') {
    const request = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(value);
    const incumbent = snapshot.workspaceRefs.find(ref => ref.serverId === move.workspace.serverId
      && ref.id === move.currentTarget.workspaceId && ref.machineId === move.currentTarget.machineId);
    return Boolean(incumbent && request.workspaceRoot === incumbent.rootPath && await requester.isCurrent());
  }
  const request = DaemonLocalServiceLauncherStartRequestV1Schema.parse(value);
  const destination = resolveWorkspaceSyncWorkerTarget({ serverId: move.workspace.serverId, sourceWorkspaceRefId: move.workspace.refId,
    targetMachineId: move.selectedTarget.machineId, workspaceRefs: snapshot.workspaceRefs,
    relationships: snapshot.relationships, childMachines: snapshot.childMachines });
  return destination.ok && request.workspace?.workspaceId === destination.target.id
    && request.workspace.rootPath === destination.target.rootPath && await requester.isCurrent();
}

/** Consume the SOURCE operation's live Start permission after exact child verification. */
export async function claimReviewedServiceMoveStart(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal: AbortSignal;
}>): Promise<import('@happier-dev/protocol/workspaces/projectServiceRelocationV1').ProjectServiceMoveStartClaimResultV1> {
  const unavailable = { kind: 'refused', reasonCode: 'service_move_start_authority_unavailable' } as const;
  const requester = readRequesterAccountActionContext(input.authorization);
  const move = await readReviewedServiceMoveInput(input);
  if (!requester || !move || input.signal.aborted) return unavailable;
  const { ProjectServiceMoveStartClaimV1Schema, ProjectServiceMoveStartClaimResultV1Schema } = await import('@happier-dev/protocol/workspaces/projectServiceRelocationV1');
  const { callExactMachineRpc } = await import('@/session/transport/rpc/machineRpc');
  try {
    const result = ProjectServiceMoveStartClaimResultV1Schema.safeParse(await callExactMachineRpc({
      credentials: requester.credentials, serverUrl: requester.serverHttpBaseUrl,
      machineId: input.authorization.binding.machineId, method: RPC_METHODS.DAEMON_SERVICE_MOVE_START_CLAIM,
      request: ProjectServiceMoveStartClaimV1Schema.parse({ requestId: input.authorization.binding.requestId,
        installationId: input.authorization.binding.installationId, input: move }),
      requireCurrentMachine: true, requiredMachineKind: 'persistent', timeoutMs: null, signal: input.signal,
      authorityCeiling: 'account_automation',
    }));
    return result.success && !input.signal.aborted && await requester.isCurrent() ? result.data : unavailable;
  } catch { return unavailable; }
}

/** Fresh authenticated installation publication; offline is not revocation. */
export async function readExternalActionInstalledMachine(input: Readonly<{
  serverHttpBaseUrl: string;
  machineId: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>): Promise<(z.infer<typeof ExternalActionMachineBootstrapV1Schema> & Readonly<{ installationPublicKey?: string | null }>) | null> {
  const publication = await axios.get<unknown>(`${normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)}/v1/machines/${encodeURIComponent(input.machineId)}`, {
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...input.headers },
    ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  });
  const raw = publication.data && typeof publication.data === 'object' && 'machine' in publication.data
    ? publication.data.machine : null;
  const installed = z.looseObject({ ...ExternalActionMachineBootstrapV1Schema.shape,
    installationPublicKey: z.nullish(z.string().check(z.base64())),
  }).safeParse(raw);
  return publication.status >= 200 && publication.status < 300 && installed.success
    && installed.data.id === input.machineId && installed.data.installationId
    && installed.data.kind === 'persistent' && installed.data.revokedAt === null
    && installed.data.replacedByMachineId === null ? installed.data : null;
}

/** Schema-checked provenance projection only; Home still verifies the issued root and current principal. */
export function resolveExternalActionRootInvocationAuthority(authorization: ExternalActionExecutionAuthorizationV1): ActionRequiredAuthority {
  const binding = authorization.binding;
  const credential = binding.sessionActionOrigin || binding.workflowActionOrigin ? 'agent'
    : 'authentication' in binding ? binding.authentication.kind : 'api_token';
  return resolveInvocationAuthority({ credential, surface: 'rpc' });
}

/** Account ingress keeps its admitted surface; an unstamped root uses its authenticated client kind. */
export function resolveExternalActionAccountInvocationSurface(authenticationKind: 'account' | 'terminal' | undefined,
  surface?: ActionExecutorContext['surface']): NonNullable<ActionExecutorContext['surface']> {
  return surface ?? (authenticationKind === 'terminal' ? 'cli' : 'ui');
}

/**
 * The device-local profile id routes a request to one Home, while the observed
 * stable identity binds Home-issued authorization. They are deliberately
 * independent because a profile id is not cryptographic identity evidence.
 */
export type ExternalActionHomeBinding = Readonly<{
  serverId?: string;
  serverIdentityId?: string;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
}>;

type OriginalAccountActionInput = Readonly<{
  actionId: string;
  input: unknown;
  requestId: string;
  target: ExternalActionTargetV1;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  serverIdentityId?: string;
  authority?: ActionExecutorContext['authority'];
  /** Host provenance retained inside the existing installation-bound private box. */
  invocation?: ExternalActionRequesterInvocationV1;
  /** A human confidentiality decision, distinct from the target Action's Ask first policy. */
  onRequesterSessionCredentialDisclosure?: (disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => boolean | void | Promise<boolean | void>;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>;

/** Home-bound managed effects, finite work, owned-copy review and terminal access need Machine
 * admission even on an own target. Local approval replay alone cannot supply it. */
export function requiresOriginalAccountMachineActionProof(actionId: string, input?: unknown): boolean {
  const hasSession = input !== null && typeof input === 'object' && 'sessionId' in input
    && typeof input.sessionId === 'string' && input.sessionId.trim().length > 0;
  const detachedRunLaunch = !hasSession && (actionId === 'execution.run.start' || actionId === 'execution.run.ensure'
    || actionId === 'execution.run.send' || actionId === 'execution.run.ensure_or_start');
  return Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) || actionId === 'projects.inspect'
    || actionId === 'projects.open' || actionId === 'projects.service.relocate'
    || actionId === 'localServices.launcher.start' || actionId === 'localServices.actions.stopManaged'
    || actionId === 'localServices.actions.restartManaged'
    || ACTION_ID_FAMILIES_V1.machine_processes.some(id => id === actionId)
    || actionId === 'machines.vitals.get' || actionId === 'machines.vitals.history.get'
    || ACTION_ID_FAMILIES_V1.machine_guard.some(id => id === actionId)
    || ACTION_ID_FAMILIES_V1.machine_storage.some(id => id === actionId)
    || actionId === 'machines.resources.policy.set'
    || ACTION_ID_FAMILIES_V1.machine_work_summary.some(id => id === actionId)
    || ACTION_ID_FAMILIES_V1.usage_sources.some(id => id === actionId && id !== 'usage.sources.dismiss')
    || ACTION_ID_FAMILIES_V1.machine_agent_install.some(id => id === actionId)
    || detachedRunLaunch
    || actionId === 'projects.worker.status' || actionId === 'projects.worker.copy.inspect' || actionId === 'projects.worker.copy.retire'
    || actionId === 'projects.execution.output.read' || actionId === 'projects.execution.output.copy'
    || actionId === 'machines.environment.apply' || isMachineTerminalActionId(actionId)
    || actionId === 'machines.managed.acquire' || actionId === 'machines.managed.inspect'
    || actionId === 'machines.managed.bootstrap.retry' || MANAGED_CONTROL_ACTION_IDS_V1.some(id => id === actionId);
}

export function dispatchOriginalAccountAction(input: OriginalAccountActionInput & Readonly<{ foreignTargetOnly: true }>): Promise<ActionExecuteResult | null>;
export function dispatchOriginalAccountAction(input: OriginalAccountActionInput): Promise<ActionExecuteResult>;
/** Original Account/terminal delivery enters Home before a retained guest can accept it.
 * Session input names its existing publisher custody; Machine targets retain
 * the incumbent disclosure and signed-requester-context admission.
 */
export async function dispatchOriginalAccountAction(input: OriginalAccountActionInput & Readonly<{ foreignTargetOnly?: true }>): Promise<ActionExecuteResult | null> {
  const fail = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
  const phase = <T>(name: string, read: () => T | Promise<T>) => runTracedExternalActionInnerStage(`dispatch.${name}`, read);
  input.signal?.throwIfAborted();
  const claims = decodeJwtPayload(input.credentials.token);
  const provenance = readAuthTokenProvenance(claims, { allowLegacyHome: false });
  const accountId = readAccountIdFromToken(input.credentials.token);
  const homeUrl = normalizeServerHttpBaseUrl(input.serverHttpBaseUrl);
  if (input.target.kind === 'session' && input.actionId !== 'session.message.send') return fail('target_unavailable');
  const requiresMachineProof = requiresOriginalAccountMachineActionProof(input.actionId, input.input);
  const isCurrent = async () => !input.signal?.aborted && (!input.isCurrent || await phase('currentness', () => input.isCurrent!()));
  if (!await isCurrent()) return fail('target_unavailable');
  // This branch only chooses the incumbent own-account path. Home still owns
  // authentication and the destination owns its Action admission.
  let machines: Awaited<ReturnType<typeof listCurrentAccountMachines>> | undefined;
  if (input.foreignTargetOnly) {
    if (input.target.kind !== 'machine') return fail('target_unavailable');
    const machineId = input.target.machineId;
    machines = await phase('machine_inventory', () => listCurrentAccountMachines({ token: input.credentials.token, serverHttpBaseUrl: homeUrl,
      ...(input.signal ? { signal: input.signal } : {}) }));
    if (!await isCurrent()) return fail('target_unavailable');
    const own = machines.find(row => row.id === machineId);
    const ordinary = readAuthTokenProvenance(claims, { allowLegacyHome: true });
    if (!requiresMachineProof && ordinary?.provenance.kind === 'account'
      && ordinary.provenance.authority === 'present_user' && input.authority !== 'account_automation'
      && accountId && own?.access?.custodian.accountId === accountId) return null;
  }
  const extras = claims && typeof claims.extras === 'object' && claims.extras !== null && !Array.isArray(claims.extras)
    ? claims.extras as Readonly<Record<string, unknown>> : {};
  const kind = provenance?.provenance.kind;
  const authentication = ExternalActionSignedAuthenticationV1Schema.safeParse({ kind, tokenEpoch: claims?.tokenEpoch ?? extras.tokenEpoch });
  if (!accountId || !authentication.success
    || !((kind === 'account' && provenance?.provenance.authority === 'present_user')
      || (kind === 'terminal' && provenance?.provenance.authority === 'account_automation'))) return fail('admission_unavailable');
  const invocationAuthority = resolveInvocationAuthority({ credential: kind, surface: 'rpc' });
  const headers = { Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json',
    ...(invocationAuthority === 'account_automation' || input.authority === 'account_automation'
      ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) };
  const readInstalledPublication = (machineId: string) => phase('installed_machine', () => readExternalActionInstalledMachine({
    serverHttpBaseUrl: homeUrl, machineId, headers, ...(input.signal ? { signal: input.signal } : {}),
  }));
  // These passive reads already have the exact target and authenticated requester. Join them
  // before interpreting mode/ownership, minting authority or disclosing material.
  const [modeRead, inventoryRead, installedRead] = await Promise.allSettled([
    phase('account_mode', () => readAccountEncryptionModeOnce({ request: () => axios.get<unknown>(`${homeUrl}/v1/account/encryption`, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    }) })),
    input.target.kind === 'machine' && !machines
      ? phase('machine_inventory', () => listCurrentAccountMachines({ token: input.credentials.token, serverHttpBaseUrl: homeUrl,
        ...(input.signal ? { signal: input.signal } : {}) })) : machines,
    input.target.kind === 'machine' && requiresMachineProof && input.serverIdentityId
      ? readInstalledPublication(input.target.machineId) : undefined,
  ]);
  // Preserve mode refusal/error precedence while settling all passive reads.
  if (modeRead.status === 'rejected') throw modeRead.reason;
  const mode = modeRead.value;
  if (mode.kind !== 'resolved') return fail('content_unavailable');
  if (inventoryRead.status === 'rejected') throw inventoryRead.reason;
  machines = inventoryRead.value;
  let machine: CurrentAccountMachineInventoryItem | undefined;
  let foreign = false;
  if (input.target.kind === 'machine') {
    const machineId = input.target.machineId;
    machine = machines?.find(row => row.id === machineId);
    // Offline remains a retained target; current Home admission still decides
    // whether the requested Action can reach this installation.
    if (!machine || machine.kind !== 'persistent' || machine.revokedAt !== null || machine.replacedByMachineId !== null
      || !machine.access || machine.access.accessState !== 'ready') return fail('admission_unavailable');
    if (!await isCurrent()) return fail('target_unavailable');
    foreign = machine.access.custodian.accountId !== accountId;
    if (!foreign && machine.access.resourceMode !== mode.mode) return fail('admission_unavailable');
    if (foreign && ((kind !== 'account' && kind !== 'terminal') || kind === 'account' && input.authority === 'account_automation'
      || input.credentials.credentialProvenance === 'api_token')) return fail('requester_account_material_unavailable');
  }
  let material: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }> | undefined;
  if (mode.mode === 'e2ee') {
    if (!input.serverIdentityId) return fail('admission_unavailable');
    try {
      const keyed = requireAccountEncryptionCredentials(input.credentials).encryption;
      material = { type: 'dataKey', machineKey: keyed.type === 'dataKey'
        ? keyed.machineKey : deriveAccountMachineKeyFromRecoverySecret(keyed.secret) };
    } catch { return fail('content_unavailable'); }
  }
  const actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
  const binding = material ? { serverIdentityId: input.serverIdentityId!, accountId, authentication: authentication.data,
    actionId, requestId: input.requestId, target: input.target } satisfies ExternalActionEncryptionBindingV2 : undefined;
  const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(actionId, input.input);
  const envelope = binding && material ? sealExternalActionRequestV2({ binding, material, input: input.input, randomBytes })
    : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: input.requestId, target: input.target, input: input.input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  let body: unknown = envelope;
  const access = machine?.access;
  if (machine && access && (foreign || requiresMachineProof)) {
    if (!input.serverIdentityId) return fail('admission_unavailable');
    if (foreign && !input.onRequesterSessionCredentialDisclosure) return fail('requester_credential_disclosure_required');
    const readInstalledMachine = async (observed: CurrentAccountMachineInventoryItem) => {
      const isOriginalTarget = input.target.kind === 'machine' && observed.id === input.target.machineId && requiresMachineProof;
      if (isOriginalTarget && installedRead.status === 'rejected') throw installedRead.reason;
      const installed = isOriginalTarget && installedRead.status === 'fulfilled' ? installedRead.value
        : await readInstalledPublication(observed.id);
      if (!installed || installed.access?.accessState !== 'ready'
        || installed.access.custodian.accountId !== observed.access?.custodian.accountId
        || installed.access.resourceMode !== observed.access?.resourceMode || !await isCurrent()) return null;
      return installed;
    };
    const installed = await readInstalledMachine(machine);
    if (!installed) return fail('admission_unavailable');
    const minted = await phase('mint_authorization', () => mintExternalActionExecutionAuthorization({ actionId, envelope, machineId: machine.id,
      pat: input.credentials.token, serverHttpBaseUrl: homeUrl,
      ...(input.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
      ...(input.signal ? { signal: input.signal } : {}) }));
    if (!minted.ok) return fail(minted.code);
    const root = minted.authorization.binding;
    if (!('authentication' in root) || root.authentication.kind !== authentication.data.kind
      || root.authentication.tokenEpoch !== authentication.data.tokenEpoch || root.accountId !== accountId
      || root.custodianAccountId !== access.custodian.accountId || root.serverIdentityId !== input.serverIdentityId
      || root.machineId !== machine.id || root.installationId !== installed.installationId
      || root.accountEncryptionMode !== mode.mode || root.actionId !== actionId || root.requestId !== input.requestId
      || root.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope)
      || !externalActionTargetsEqualV1(root.target, input.target) || root.sessionActionOrigin || root.sessionActionSource
      || root.workflowActionOrigin || root.managedContinuation || root.handoffContinuation
      || !await isCurrent()) return fail('admission_unavailable');
    const confirmDisclosure = async (recipient: CurrentAccountMachineInventoryItem): Promise<ActionExecuteResult | null> => {
      if (kind === 'account' && input.authority === 'account_automation'
        || input.credentials.credentialProvenance === 'api_token') return fail('requester_account_material_unavailable');
      if (!input.onRequesterSessionCredentialDisclosure) return fail('requester_credential_disclosure_required');
      if (mode.mode === 'plain' && input.credentials.encryption !== null) return fail('content_unavailable');
      let confirmed: boolean | void;
      try {
        confirmed = await input.onRequesterSessionCredentialDisclosure(projectRequesterSessionCredentialDisclosure({
          disposition: 'ordinary_requester', accountId, machineId: recipient.id,
          ...(recipient.access ? { custodian: recipient.access.custodian } : {}),
        }));
      } catch { return fail(input.signal?.aborted ? 'cancelled' : 'requester_credential_disclosure_declined'); }
      if (confirmed !== true) return fail('requester_credential_disclosure_declined');
      return await isCurrent() ? null : fail(input.signal?.aborted ? 'cancelled' : 'target_unavailable');
    };
    let authorization = minted.authorization;
    try {
      if (foreign || input.invocation) {
        if (!installed.installationPublicKey) return fail('admission_unavailable');
        if (foreign) {
          const refusal = await confirmDisclosure(machine);
          if (refusal) return refusal;
        }
        authorization = sealExternalActionRequesterAccountContextV1({ authorization,
          credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token }, purpose: { kind: 'external_action' },
          ...(input.invocation ? { invocation: input.invocation } : {}),
          installationPublicKey: decodeBase64(installed.installationPublicKey), randomBytes });
      }
      const wake = authorization.managedFiniteWake;
      if (wake) {
        const controller = machines?.find(row => row.id === wake.target.controller.machineId);
        if (!controller || controller.kind !== 'persistent' || controller.revokedAt !== null
          || controller.replacedByMachineId !== null || controller.access?.accessState !== 'ready') return fail('admission_unavailable');
        const installedController = await readInstalledMachine(controller);
        if (!installedController?.installationPublicKey
          || installedController.installationId !== wake.target.controller.installationId) return fail('admission_unavailable');
        const controllerKey = decodeBase64(installedController.installationPublicKey, 'base64');
        if (encodeBase64(controllerKey, 'base64url') !== wake.installationPublicKey) return fail('admission_unavailable');
        if (controller.access.custodian.accountId !== accountId) {
          const refusal = await confirmDisclosure(controller);
          if (refusal) return refusal;
          authorization = sealExternalActionRequesterAccountContextV1({ authorization,
            credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token }, purpose: { kind: 'managed_finite_wake', target: wake.target },
            installationPublicKey: controllerKey, randomBytes });
        }
      }
      body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: machine.id, envelope,
        executionAuthorization: authorization });
    } catch { return fail('content_unavailable'); }
  }
  input.signal?.throwIfAborted();
  if (!await isCurrent()) return fail('target_unavailable');
  try {
    const response = await phase('delivery', () => axios.post<unknown>(`${homeUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`, body, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    }));
    // A received operation receipt remains true even when observation retired.
    if (isExternalActionSubmittedUnknownHttpResponse(response.status, response.data)) return fail('outcome_unknown');
    if (response.status < 200 || response.status >= 300) {
      const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
      if (refusal.success && 'requestId' in refusal.data && refusal.data.requestId !== undefined
        && refusal.data.requestId !== envelope.requestId) return fail('invalid_action_output');
      if (refusal.success && 'code' in refusal.data
        && (refusal.data.code === 'action_not_admitted' || refusal.data.code === 'action_outcome_unknown')) {
        return projectUnexpectedActionFailureV1(refusal.data.code === 'action_not_admitted' ? false : null, refusal.data.requestId);
      }
      return fail(refusal.success ? 'code' in refusal.data ? refusal.data.code : refusal.data.error : 'project_transport_unavailable');
    }
    if (envelope.v === 2 && material && binding) return openExternalActionResponseV2({ envelope: response.data,
      binding, request: envelope, material }) ?? fail('invalid_action_output');
    const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse(response.data);
    return parsed.success && parsed.data.actionId === actionId && parsed.data.requestId === envelope.requestId
      ? parsed.data.execution : fail('invalid_action_output');
  } catch { return fail('outcome_unknown'); }
}

export function createExternalActionMachineRpcExecution(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  installationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  workspaceSyncSourceRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSeedRoutingV1;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const authorization = input.context?.externalActionExecutionAuthorization;
  const target = input.context?.externalActionTarget;
  if (!authorization || !target || !input.requestId) return null;
  const effectActionId = ExternalActionActionIdV1Schema.parse(input.effectActionId);
  return {
    v: 1,
    authorization,
    effectActionId,
    target,
    installationId: input.installationId,
    machineSignature: signExternalActionMachineRpcRequestV1({
      authorizationToken: authorization.token,
      requesterAccountContext: authorization.requesterAccountContext,
      effectActionId,
      target,
      installationId: input.installationId,
      event: SOCKET_RPC_EVENTS.CALL,
      method: input.method,
      requestId: input.requestId,
      ...(input.params === undefined ? {} : { params: input.params }),
      ...(input.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: input.workspaceSyncSourceRouting } : {}),
      ...(input.workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting: input.workspaceSyncSourceWriterTargetRouting } : {}),
      ...(input.workspaceSyncSeedRouting ? { workspaceSyncSeedRouting: input.workspaceSyncSeedRouting } : {}),
      privateKey: input.privateKey,
    }),
  };
}

/**
 * Original Session, exact handoff custody or the reviewed Move SOURCE may forward its Home-admitted request.
 * This uses the source key, while the signed bytes still name the actual
 * destination installation. It is never a destination-signature fallback.
 */
export function readExternalActionSourceMachineRpcSigner(
  authorization: ExternalActionExecutionAuthorizationV1,
): Readonly<{ machineId: string; installationId: string }> | null {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  if ((binding.actionId === 'projects.service.relocate' || binding.actionId === 'discussion.second_opinion.start') && binding.target.kind === 'machine'
    && binding.target.machineId === binding.machineId) return { machineId: binding.machineId, installationId: binding.installationId };
  if ('authentication' in binding && binding.sessionActionOrigin && binding.sessionActionSource) {
    return binding.sessionActionSource;
  }
  const admission = binding.handoffAdmission;
  if (!(binding.handoffContinuation || binding.handoffPreflight) || !admission
    || !(binding.machineId === admission.sourceMachineId && binding.installationId === admission.sourceInstallationId
      || binding.machineId === admission.targetMachineId && binding.installationId === admission.targetInstallationId)) return null;
  return { machineId: admission.sourceMachineId, installationId: admission.sourceInstallationId };
}

export function createExternalActionSourceMachineRpcExecution(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  sourceMachineId: string;
  sourceInstallationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  const source = readExternalActionSourceMachineRpcSigner(parsed.data);
  if (!source || source.machineId !== input.sourceMachineId
    || source.installationId !== input.sourceInstallationId
    || input.target.kind !== 'machine' || binding.machineId !== input.target.machineId
    || !externalActionTargetsEqualV1(binding.target, input.target)
    || binding.actionId === 'projects.service.relocate'
      && readProjectServiceMoveChildEffectV1(input.method.slice(input.method.indexOf(':') + 1)) !== input.effectActionId
    || binding.actionId === 'discussion.second_opinion.start'
      && (input.effectActionId !== 'session.spawn_new' || !isDiscussionSecondOpinionModelRpcMethodV1(input.method.slice(input.method.indexOf(':') + 1)))
    || binding.actionId !== 'projects.service.relocate' && binding.actionId !== 'discussion.second_opinion.start'
      && !input.method.startsWith(`${binding.machineId}:`)) return null;
  return createExternalActionMachineRpcExecution({
    context: { surface: 'rpc', externalActionExecutionAuthorization: input.authorization, externalActionTarget: input.target },
    effectActionId: input.effectActionId,
    installationId: binding.installationId,
    method: input.method,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.params === undefined ? {} : { params: input.params }),
    privateKey: input.privateKey,
  });
}

type ExternalActionAuthorizationHttpFailure = Readonly<{
  ok: false;
  code: 'invalid_token' | 'credential_scope_denied' | 'auth_unavailable' | 'server_unavailable' | 'target_unavailable';
  /** Private preparation fact; HTTP adapters still project only their existing code. */
  retryable?: true;
}>;

export type ExternalActionAuthorizationHttpResult =
  | Readonly<{ ok: true; authorization: ExternalActionExecutionAuthorizationV1 }>
  | ExternalActionAuthorizationHttpFailure;

export function createExternalActionAuthorizedRequestHeaders(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): Readonly<Record<string, string>> {
  return {
    ...(input.idempotencyKey === undefined ? {} : { 'Idempotency-Key': input.idempotencyKey }),
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorization.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(input.target),
    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
      authorizationToken: input.authorization.token,
      effectActionId: input.effectActionId,
      target: input.target,
      installationId: input.installationId,
      requestId: input.authorization.binding.requestId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      privateKey: input.privateKey,
    }),
  };
}

/** Attach HTTP-only requester ports to the incumbent, Home-proved carrier. */
export async function projectExternalActionRequesterHttpAuthorization(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  target: ExternalActionTargetV1;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  isCurrent?: () => Promise<boolean>;
  /** Exact child ingress already rechecks the retained SOURCE packet at Home. */
  forwardedMove?: Readonly<{ credentials: StoredCredentials; isCurrent(): Promise<boolean> }>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success || parsed.data.binding.serverIdentityId !== input.serverIdentityId
    || (parsed.data.binding.installationId !== input.installationId && !input.forwardedMove)
    || input.forwardedMove && parsed.data.binding.actionId !== 'projects.service.relocate'
      && parsed.data.binding.actionId !== 'discussion.second_opinion.start'
    || !input.serverId || !input.serverHttpBaseUrl) return null;
  const authorization: ExternalActionExecutionAuthorizationV1 = { ...parsed.data };
  const requesterAccountProjection = input.authorization.requesterAccountProjection;
  const requesterContext = readRequesterAccountActionContext(input.authorization);
  if (requesterContext && (requesterContext.authorization.token !== authorization.token
    || !sameStrictJsonValue(requesterContext.authorization.binding, authorization.binding))) return null;
  const admittedCustody = requesterContext?.isCustodyCurrent;
  const nativePreparationReadCustody = authorization.binding.actionId === 'projects.service.relocate'
    || authorization.binding.actionId === 'discussion.second_opinion.start'
    || authorization.binding.actionId === 'execution.run.start'
    || authorization.binding.actionId === 'execution.run.ensure'
    || authorization.binding.actionId === 'execution.run.send'
    || authorization.binding.actionId === 'execution.run.ensure_or_start'
    ? input.forwardedMove ?? (requesterContext ? {
      credentials: requesterContext.credentials,
      isCurrent: () => requesterContext.isCustodyCurrent
        ? requesterContext.isCustodyCurrent() : requesterContext.isCurrent(),
    } : undefined) : undefined;
  const projectMachineReadCustody = authorization.binding.actionId === 'projects.script.run'
    || authorization.binding.actionId === 'projects.compute.exec'
    || authorization.binding.actionId === 'localServices.launcher.start'
    || authorization.binding.actionId === 'projects.worker.status' ? requesterContext : undefined;
  const projectRowReadCustody = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, authorization.binding.actionId)
    || authorization.binding.actionId === 'projects.inspect'
    || authorization.binding.actionId === 'projects.worker.status'
    || authorization.binding.actionId === 'projects.execution.output.read'
    || authorization.binding.actionId === 'projects.execution.output.copy' ? requesterContext : undefined;
  if (requesterAccountProjection && (requesterAccountProjection.accountId !== authorization.binding.accountId
    || requesterAccountProjection.serverId !== input.serverId)) return null;
  const locallyCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      if (input.signal?.aborted || signal?.aborted) return false;
      // Installed custody supplies the Account projection's exact function as
      // its local guard. Read it once here; a distinct Machine guard still runs.
      const current = input.isCurrent && input.isCurrent !== requesterAccountProjection?.isCurrent
        ? await input.isCurrent() : true;
      if (!current || input.signal?.aborted || signal?.aborted) return false;
      const accountCurrent = !requesterAccountProjection
        || await requesterAccountProjection.isCurrent();
      return accountCurrent && !input.signal?.aborted && !signal?.aborted;
    } catch (error) {
      refuseExternalActionPhase('requester_http_local_currentness', authorization.binding.machineId, error);
      rethrowRequesterHomeReadFailure(error);
      return false;
    }
  };
  const verifyCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    if (!await locallyCurrent(signal)) return false;
    if (input.forwardedMove) return await input.forwardedMove.isCurrent() && await locallyCurrent(signal);
    const current = await verifyExternalActionExecutionAuthorizationCurrent({
      authorization,
      effectActionId: authorization.binding.actionId,
      target: input.target,
      installationId: input.installationId,
      privateKey: input.privateKey,
      serverHttpBaseUrl: input.serverHttpBaseUrl,
      ...(signal ?? input.signal ? { signal: signal ?? input.signal } : {}),
    });
    return current && await locallyCurrent(signal);
  };
  // This exact private custody has already passed Home admission. Rebuilding
  // its HTTP ports is the same authority decision, not a new native effect.
  // Wire-only carriers still need their own fresh proof.
  if (!await (admittedCustody ? locallyCurrent() : verifyCurrent())) return null;
  const isCurrent = admittedCustody ? locallyCurrent : verifyCurrent;
  if (requesterAccountProjection) {
    Object.defineProperty(authorization, 'requesterAccountProjection', {
      value: requesterAccountProjection, enumerable: false,
    });
  }
  const requesterHttpProjection: NonNullable<ExternalActionExecutionAuthorizationV1['requesterHttpProjection']> = {
    accountId: authorization.binding.accountId,
    serverId: input.serverId,
    serverIdentityId: input.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    ...(authorization.binding.accountEncryptionMode
      ? { accountEncryptionMode: authorization.binding.accountEncryptionMode } : {}),
    isCurrent,
    createRequestHeaders: async (request) => {
      // Topology is private Account data, not authority conferred by a Project
      // execution root. Spend only its exact, still-current requester read port.
      if (projectRowReadCustody && request.effectActionId === authorization.binding.actionId
        && request.method === 'POST' && (request.path === '/v1/account/project-rows/read'
          || request.path === '/v1/account/project-rows/list')) {
        return await (projectRowReadCustody.isCustodyCurrent ?? projectRowReadCustody.isCurrent)() && await isCurrent(request.signal)
          ? { Authorization: `Bearer ${projectRowReadCustody.credentials.token}` } : null;
      }
      // A worker-bound execution/service/status root cannot read SOURCE/controller Machine
      // content. Passive inspection and Sync topology use the same captured
      // requester read custody as Service Move; native effects keep their root.
      if (projectMachineReadCustody && request.effectActionId === authorization.binding.actionId
        && request.method === 'GET' && /^\/v1\/machines\/[^/]+$/u.test(request.path)
        && request.path !== `/v1/machines/${encodeURIComponent(authorization.binding.machineId)}`) {
        return await (projectMachineReadCustody.isCustodyCurrent ?? projectMachineReadCustody.isCurrent)() && await isCurrent(request.signal)
          ? { Authorization: `Bearer ${projectMachineReadCustody.credentials.token}` } : null;
      }
      if (nativePreparationReadCustody && (authorization.binding.actionId === 'projects.service.relocate'
        || authorization.binding.actionId === 'discussion.second_opinion.start' && request.effectActionId === 'session.spawn_new'
        || request.effectActionId === authorization.binding.actionId)) {
        // Native preparation consumes its original requester's private Account
        // read ports, as SOURCE Sync does. No bearer is put on the RPC carrier.
        const read = request.method === 'GET' && (request.path === '/v1/account/encryption'
            || /^\/v1\/machines\/[^/]+$/u.test(request.path))
          || request.method === 'POST' && ['/v1/account/project-rows/read', '/v1/account/project-rows/list',
            '/v1/account/project-trust/read', '/v1/account/project-trust/list', '/v1/projects/execution/config/read'].includes(request.path);
        if (read) return await nativePreparationReadCustody.isCurrent() && await isCurrent(request.signal)
          ? { Authorization: `Bearer ${nativePreparationReadCustody.credentials.token}` } : null;
        // SOURCE-owned placement writes retain their incumbent signed root;
        // a forwarded recipient never receives a general write port.
        if (input.forwardedMove) return null;
      }
      // Signing is synchronous and has no external effect. Check custody once
      // before releasing the headers; the destination admits the signed effect.
      const headers = createExternalActionAuthorizedRequestHeaders({
        authorization, effectActionId: request.effectActionId, target: input.target,
        installationId: input.installationId, privateKey: input.privateKey,
        method: request.method, path: request.path,
        ...(authorization.binding.actionId === 'workflow.trigger.run_now' && request.effectActionId === authorization.binding.actionId
          ? { idempotencyKey: authorization.binding.idempotencyKey } : {}),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      // An admitted installed invocation already proved the root. The HTTP
      // destination verifies this exact signed effect, including grant/epoch.
      // Keep observed encryption and installation fences here; native effects
      // use the private context's explicit fresh verification boundary instead.
      return await isCurrent(request.signal) ? headers : null;
    },
  };
  Object.defineProperty(authorization, 'requesterHttpProjection', {
    value: Object.freeze(requesterHttpProjection), enumerable: false,
  });
  return Object.freeze(authorization);
}

/** Prepare an original Account invocation; only Home's minted binding admits it. */
export async function prepareExternalActionRequesterAccountAuthorization(input: Readonly<{
  actionId: string;
  input: unknown;
  requestId: string;
  target: ExternalActionTargetV1;
  machineId: string;
  /** Account id and mode obtained from this authenticated Home's profile. */
  accountId: string;
  accountEncryptionMode: 'plain' | 'e2ee';
  /** Unverified associated-data candidate, never an authentication decision. */
  tokenEpochHint: number;
  token: string;
  /** Only the incumbent authenticated Session host supplies this origin. */
  sessionActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  workflowActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['workflowActionOrigin'];
  /** Exact incumbent Session host, independently of the destination Machine. */
  sourceMachineId?: string;
  /** Accepted managed Session work rechecks current origin policy, not an ended turn. */
  isContinuationCurrent?: (authorization: ExternalActionExecutionAuthorizationV1) => Promise<boolean>;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  isCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const isCurrent = async (): Promise<boolean> => {
    try {
      if (input.signal?.aborted) return false;
      const current = input.isCurrent ? await input.isCurrent() : true;
      return current && !input.signal?.aborted;
    } catch (error) { refuseExternalActionPhase('original_request_currentness', input.machineId, error); return false; }
  };
  // Envelope construction below is synchronous and has no external effect.
  // Check custody once immediately before minting, then again after Home replies.
  if (input.signal?.aborted) return null;
  let actionId: string;
  let authenticationKind: 'account' | 'terminal';
  let envelope: ExternalActionRequestEnvelope;
  let pendingResetStartAdmission: ExternalActionExecutionAuthorizationV1['binding']['pendingResetStartAdmission'];
  let sessionActionOrigin: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  try {
    actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
    pendingResetStartAdmission = actionId === 'session.pending.resetStart.set'
      ? projectExternalActionPendingResetStartAdmissionV1(input.input) : undefined;
    sessionActionOrigin = input.sessionActionOrigin === undefined ? undefined
      : SessionActionRpcOriginV1Schema.parse(input.sessionActionOrigin);
    if (sessionActionOrigin && sessionActionOrigin.requestId !== input.requestId) return null;
    if (sessionActionOrigin && !input.sourceMachineId?.trim()) return null;
    // Installed Session proposals still use released paired Home credentials.
    // This is only an associated-data candidate: Home verifies the credential,
    // current Session and installation proof before issuing any authorization.
    // Original headless requests retain their structured-provenance requirement.
    const provenance = readAuthTokenProvenance(decodeJwtPayload(input.token), {
      allowLegacyHome: sessionActionOrigin !== undefined || input.workflowActionOrigin !== undefined,
    });
    if (provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user') authenticationKind = 'account';
    else if (provenance?.provenance.kind === 'terminal' && provenance.provenance.authority === 'account_automation') authenticationKind = 'terminal';
    else return null;
    const authentication = ExternalActionSignedAuthenticationV1Schema.parse({ kind: authenticationKind, tokenEpoch: input.tokenEpochHint });
    if (!Number.isSafeInteger(authentication.tokenEpoch)) return null;
    if (input.accountEncryptionMode === 'e2ee') {
      if (!input.material) return null;
      envelope = sealExternalActionRequestV2({
        binding: { serverIdentityId: input.serverIdentityId, accountId: input.accountId, authentication,
          actionId, requestId: input.requestId, target: input.target },
        input: input.input, material: input.material, randomBytes,
        // Installed Session authoring inherits launch choices at the agent-start
        // owner. It carries no PAT grant needing a fully resolved public projection.
        ...(actionId === 'session.spawn_new' && !sessionActionOrigin
          ? { sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(SessionSpawnNewInputV2Schema.parse(input.input)) }
          : {}),
      });
    } else {
      const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(actionId, input.input);
      envelope = ExternalActionRequestEnvelopeSchema.parse({
        v: 1, requestId: input.requestId, target: input.target, input: input.input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    }
  } catch (error) { refuseExternalActionPhase('original_request_projection', input.machineId, error); return null; }
  if (!await isCurrent()) return null;
  const minted = await mintExternalActionExecutionAuthorization({
    actionId, envelope, machineId: input.machineId, pat: input.token,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    ...(sessionActionOrigin ? { sessionActionOrigin,
      sessionActionSource: { machineId: input.sourceMachineId!, installationId: input.installationId },
      installationProof: signMachineInstallationProof({
      payload: { version: 1, machineId: input.sourceMachineId!, installationId: input.installationId, accountId: input.accountId,
        externalActionOrigin: { homeId: input.serverIdentityId, actionId, requestId: input.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin } },
      privateKey: input.privateKey,
    }) } : {}),
    ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin,
      installationProof: signMachineInstallationProof({
        payload: { version: 1, machineId: input.machineId, installationId: input.installationId, accountId: input.accountId,
          externalActionOrigin: { homeId: input.serverIdentityId, actionId, requestId: input.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: input.workflowActionOrigin } },
        privateKey: input.privateKey,
      }) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!minted.ok) {
    if (!input.signal?.aborted && minted.retryable) {
      rethrowRequesterHomeReadFailure({ ok: false, errorCode: 'server_unreachable' });
    }
    return null;
  }
  if (!await isCurrent()) return null;
  const binding = minted.authorization.binding;
  if (!('authentication' in binding)
    || binding.accountId !== input.accountId
    || binding.authentication.kind !== authenticationKind
    || binding.authentication.tokenEpoch !== input.tokenEpochHint
    || binding.accountEncryptionMode !== input.accountEncryptionMode
    || binding.serverIdentityId !== input.serverIdentityId
    || (!sessionActionOrigin || input.sourceMachineId === input.machineId) && binding.installationId !== input.installationId
    || binding.machineId !== input.machineId
    || binding.actionId !== actionId
    || binding.requestId !== input.requestId
    || binding.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope)
    || !sameStrictJsonValue(binding.pendingResetStartAdmission, pendingResetStartAdmission)
    || !sameStrictJsonValue(binding.sessionActionOrigin, sessionActionOrigin)
    || !sameStrictJsonValue(binding.workflowActionOrigin, input.workflowActionOrigin)
    || !sameStrictJsonValue(binding.sessionActionSource, sessionActionOrigin
      ? { machineId: input.sourceMachineId, installationId: input.installationId } : undefined)
    || !externalActionTargetsEqualV1(binding.target, input.target)) return null;
  // The destination daemon owns HTTP effect signatures. A remote source only
  // forwards the same Home proof; it must not impersonate the destination signer.
  if (sessionActionOrigin && input.sourceMachineId !== input.machineId) return Object.freeze(minted.authorization);
  const continuationChecker = input.isContinuationCurrent;
  const continuationCurrent = sessionActionOrigin && continuationChecker
    ? async () => await continuationChecker(minted.authorization)
    : isCurrent;
  return await projectExternalActionRequesterHttpAuthorization({
    authorization: minted.authorization,
    serverId: input.serverId, serverIdentityId: input.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl, target: input.target,
    installationId: input.installationId, privateKey: input.privateKey, isCurrent: continuationCurrent,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** The installed Workflow executor uses one signer for Machine and Session effects. */
export async function prepareInstalledWorkflowActionAuthorization(input: Readonly<{
  credentials: StoredCredentials;
  context: ActionExecutorContext;
  actionId: string;
  input: unknown;
  target: ExternalActionTargetV1;
  machineId: string;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  isCurrent?: () => Promise<boolean>;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const caller = input.context.actionCaller;
  const requestId = input.context.actionRequestId;
  const accountId = readAccountIdFromToken(input.credentials.token);
  if (caller?.kind !== 'workflowRun' || !requestId || !accountId
    || input.context.executionRunWorkflowRunId !== caller.runId
    || input.target.kind === 'session' && typeof input.isCurrent !== 'function') return null;
  const start = input.context.agentStartContext;
  const sessionAuthority = input.target.kind === 'session' && start?.caller.kind === 'originless'
    && start.caller.runId === caller.runId && start.baseline.machineId === input.machineId
    ? { authorization: caller.authorization, runDepth: start.caller.runDepth,
      ...(start.caller.runOriginSessionId ? { runOriginSessionId: start.caller.runOriginSessionId } : {}),
      directory: start.baseline.directory, workspaceWrites: input.context.workspaceWrites ?? 'deny' as const }
    : undefined;
  if (input.target.kind === 'session' && !sessionAuthority) return null;
  const payload = decodeJwtPayload(input.credentials.token);
  const extras = payload?.extras;
  const tokenEpochHint = payload?.tokenEpoch ?? (extras && typeof extras === 'object' && 'tokenEpoch' in extras ? extras.tokenEpoch : undefined) ?? 0;
  if (typeof tokenEpochHint !== 'number' || !Number.isSafeInteger(tokenEpochHint) || tokenEpochHint < 0) return null;
  const encryption = await fetchAccountEncryptionCurrentness({ token: input.credentials.token,
    serverBaseUrl: input.serverHttpBaseUrl, signal: input.context.signal });
  const material = input.credentials.encryption?.type === 'legacy'
    ? { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(input.credentials.encryption.secret) }
    : input.credentials.encryption;
  return await prepareExternalActionRequesterAccountAuthorization({ ...input, accountId,
    requestId, token: input.credentials.token, tokenEpochHint, accountEncryptionMode: encryption.mode,
    workflowActionOrigin: { runId: caller.runId, requestId, ...(sessionAuthority ? { sessionAuthority } : {}) },
    ...(material ? { material } : {}), signal: input.context.signal });
}

export function resolveExternalActionServerRequestHeaders(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  method: string;
  path: string;
  body?: unknown;
  daemonToken: string;
  serverIdentityId?: string;
  privateKey?: ExternalActionMachineRequestSigningKey;
  installationId?: string;
}>): Readonly<{ ok: true; headers: Readonly<Record<string, string>> }> | Readonly<{ ok: false }> {
  const authorization = input.context?.externalActionExecutionAuthorization;
  if (!authorization) {
    // Public Action execution never falls through to the daemon credential.
    // A direct PAT request may still complete daemon-local work while its Home
    // is unreachable, but any Home-bound effect remains closed.
    if (input.context?.externalActionCredential) return { ok: false };
    return { ok: true, headers: { Authorization: `Bearer ${input.daemonToken}`,
      ...(input.context?.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) } };
  }
  if (
    !input.privateKey
    || !input.installationId
    || !input.context?.externalActionTarget
    || authorization.binding.serverIdentityId !== input.serverIdentityId
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    headers: createExternalActionAuthorizedRequestHeaders({
      authorization,
      effectActionId: input.effectActionId,
      target: input.context.externalActionTarget,
      installationId: input.installationId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      privateKey: input.privateKey,
    }),
  };
}

/** A fresh managed continuation re-enters the same public Session Action owner.
 * The controller signs only its original acquire proof; Home admits and signs
 * the actual guest invocation with the original requester authority.
 */
export function isManagedSessionStartTransportAvailable(params: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  installationId: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
}>): boolean {
  const root = params.authorization?.binding;
  return root?.actionId === 'machines.managed.acquire' && root.installationId === params.installationId
    && root.target.kind === 'machine' && root.target.machineId === root.machineId
    && (root.accountEncryptionMode === 'plain' || (root.accountEncryptionMode === 'e2ee' && params.material?.machineKey.length === 32));
}

type ManagedChildDispatchParams = Readonly<{
  input: SessionSpawnNewInputV2;
  authority?: ActionRequiredAuthority;
  continuation: NonNullable<ExternalActionExecutionAuthorizationRequestV1['managedContinuation']>;
  authorization: ExternalActionExecutionAuthorizationV1;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  serverHttpBaseUrl: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  signal?: AbortSignal;
}>;
export async function dispatchManagedSessionStart(params: ManagedChildDispatchParams): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'session.spawn_new', serverId: params.input.executionTarget.serverId,
    targetMachineId: params.input.executionTarget.machineId });
}

async function dispatchManagedChild(params: Omit<ManagedChildDispatchParams, 'input'> & Readonly<{
  input: SessionSpawnNewInputV2 | MachineEnvironmentApplyInputV1;
  actionId: 'session.spawn_new' | 'machines.environment.apply'; serverId: string; targetMachineId: string;
}>): Promise<ActionExecuteResult> {
  const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
  const root = params.authorization.binding;
  if (!isManagedSessionStartTransportAvailable(params)
    || root.requestId !== params.continuation.creationRequestId) return fail('admission_unavailable');
  if (params.signal?.aborted) return fail('cancelled');
  let input: SessionSpawnNewInputV2 | MachineEnvironmentApplyInputV1;
  try {
    const home = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: params.serverId });
    const serverIdentityId = assertResolvedHomeTargetIdentity(home, root.serverIdentityId);
    const destination = normalizeServerHttpBaseUrl(params.serverHttpBaseUrl);
    const capturedHome = params.authorization.requesterHttpProjection;
    const capturedDestination = capturedHome?.accountId === root.accountId
      && capturedHome.serverIdentityId === serverIdentityId
      && normalizeServerHttpBaseUrl(capturedHome.serverHttpBaseUrl) === destination;
    // An Iroh runtime origin is not the descriptor's HTTPS application URL.
    // Only the existing verified private Home port can admit that destination.
    if (normalizeServerHttpBaseUrl(home.applicationUrl) !== destination
      && (!capturedDestination || !await capturedHome!.isCurrent())) return fail('target_unavailable');
    if (params.actionId === 'session.spawn_new') {
      const parsed = SessionSpawnNewInputV2Schema.parse(params.input);
      input = { ...parsed, executionTarget: { ...parsed.executionTarget, serverId: serverIdentityId } };
    } else {
      const parsed = MachineEnvironmentApplyInputV1Schema.parse(params.input);
      if (parsed.homeId !== serverIdentityId || parsed.machineId !== params.targetMachineId) return fail('target_unavailable');
      input = parsed;
    }
  } catch (error) { refuseExternalActionPhase('managed_child_projection', params.targetMachineId, error); return fail('target_unavailable'); }
  if (params.signal?.aborted) return fail('cancelled');
  // The ordinary spawn owner namespaces identity by Action and requester.
  // Preserve its fresh acquisition correlation across an explicit retry.
  const requestId = root.requestId;
  const target = { kind: 'machine' as const, machineId: params.targetMachineId };
  const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: root.serverIdentityId,
    accountId: root.accountId, actionId: params.actionId, requestId, target,
    ...('authentication' in root ? { authentication: { kind: root.authentication.kind, tokenEpoch: root.authentication.tokenEpoch } }
      : { credentialId: root.credentialId }) };
  const envelope = root.accountEncryptionMode === 'e2ee'
    ? sealExternalActionRequestV2({ binding, input, material: params.material!, randomBytes,
        ...(params.actionId === 'session.spawn_new' ? { sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(SessionSpawnNewInputV2Schema.parse(input)) } : {}) })
    : { v: 1 as const, requestId, target, input };
  const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: target.machineId,
    envelope, managedContinuation: params.continuation });
  const path = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${params.actionId}`;
  const headers = createExternalActionAuthorizedRequestHeaders({ authorization: params.authorization,
    effectActionId: 'machines.managed.acquire', target: root.target, installationId: params.installationId,
    method: 'POST', path, body, privateKey: params.privateKey });
  try {
    const response = await axios.post<unknown>(`${params.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json',
        ...(params.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: params.authority } : {}) },
      ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = ExternalActionHttpErrorSchema.safeParse(response.data);
      if (error.success && 'requestId' in error.data && error.data.requestId !== undefined
        && error.data.requestId !== envelope.requestId) return fail('invalid_action_output');
      if (error.success && 'code' in error.data
        && (error.data.code === 'action_not_admitted' || error.data.code === 'action_outcome_unknown')) {
        return projectUnexpectedActionFailureV1(error.data.code === 'action_not_admitted' ? false : null, error.data.requestId);
      }
      return fail(error.success ? 'code' in error.data ? error.data.code : error.data.error : 'target_unavailable');
    }
    if (envelope.v === 2 && params.material) return openExternalActionResponseV2({ envelope: response.data,
      binding, request: envelope, material: params.material }) ?? fail('invalid_encrypted_envelope');
    const responseEnvelope = ExternalActionResponseEnvelopeV1Schema.safeParse(response.data);
    return responseEnvelope.success && responseEnvelope.data.actionId === params.actionId
      && responseEnvelope.data.requestId === requestId ? responseEnvelope.data.execution : fail('invalid_envelope');
  } catch (error) {
    refuseExternalActionPhase('managed_child_http', params.targetMachineId, error);
    return fail(params.signal?.aborted ? 'cancelled' : 'target_unavailable');
  }
}

export async function dispatchManagedMachineEnvironment(params: Omit<Parameters<typeof dispatchManagedSessionStart>[0], 'input'> & Readonly<{
  input: MachineEnvironmentApplyInputV1;
  serverId: string;
}>): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'machines.environment.apply', targetMachineId: params.input.machineId });
}

/** Provenance for the incumbent local host Account path, not effect authority.
 * Home still mints and verifies every setup Action's exact target proof. */
export function isOriginalLocalManagedSetupContext(input: Readonly<{
  context: ActionExecutorContext; credentials: StoredCredentials; custodianAccountId: string; homeId: string;
}>): boolean {
  const { context, credentials } = input;
  const accountId = readAccountIdFromToken(credentials.token);
  const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: false });
  return Boolean(accountId && accountId === input.custodianAccountId
    && credentials.credentialProvenance === 'stored_session' && provenance?.provenance.kind === 'account'
    && provenance.provenance.authority === 'present_user'
    && (context.surface === 'cli' || context.surface === 'ui') && context.actionCaller?.kind === 'host'
    && context.actionRequestId && context.serverIdentityId === input.homeId
    && (!context.runtimeAccountId || context.runtimeAccountId === accountId)
    && !('machineAdmission' in context && context.machineAdmission) && !context.externalActionCredential && !context.externalActionExecutionAuthorization
    && !context.rpcSessionAuthorization && !context.causalPermissionAuthority && !context.sessionInputSource
    && !context.runtimeRunId && !context.executionRunWorkflowRunId);
}

/** Original local host creation has no Session continuation proof. Its setup
 * re-enters the incumbent Account Action ingress, never an unsigned guest RPC. */
export async function dispatchLocalManagedMachineEnvironment(params: Readonly<{
  input: MachineEnvironmentApplyInputV1;
  context: ActionExecutorContext;
  credentials: StoredCredentials;
  custodianAccountId: string;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
}>): Promise<ActionExecuteResult> {
  if (!isOriginalLocalManagedSetupContext({ ...params, homeId: params.input.homeId }))
    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  return dispatchOriginalAccountAction({ actionId: 'machines.environment.apply', input: params.input,
    requestId: params.context.actionRequestId!, target: { kind: 'machine', machineId: params.input.machineId },
    credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl, serverIdentityId: params.input.homeId,
    ...(params.context.authority ? { authority: params.context.authority } : {}), isCurrent: params.isCurrent,
    ...(params.context.signal ? { signal: params.context.signal } : {}) });
}

export async function mintExternalActionExecutionAuthorization(input: Readonly<{
  actionId: string;
  envelope: ExternalActionRequestEnvelope;
  machineId: string;
  pat: string;
  serverHttpBaseUrl: string;
  authorityCeiling?: 'account_automation';
  sessionActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  workflowActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['workflowActionOrigin'];
  sessionActionSource?: ExternalActionExecutionAuthorizationRequestV1['sessionActionSource'];
  installationProof?: ExternalActionExecutionAuthorizationRequestV1['installationProof'];
  signal?: AbortSignal;
}>): Promise<ExternalActionAuthorizationHttpResult> {
  const path = bindExternalActionExecutionAuthorizationHttpPathV1(input.actionId);
  let response;
  try {
    response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}${path}`,
      { v: 1, machineId: input.machineId, envelope: input.envelope,
        ...(input.sessionActionOrigin ? { sessionActionOrigin: input.sessionActionOrigin } : {}),
        ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin } : {}),
        ...(input.sessionActionSource ? { sessionActionSource: input.sessionActionSource } : {}),
        ...(input.installationProof ? { installationProof: input.installationProof } : {}) },
      {
        headers: { Authorization: `Bearer ${input.pat}`, 'Content-Type': 'application/json',
          ...(input.authorityCeiling === 'account_automation'
            || readAuthTokenProvenance(decodeJwtPayload(input.pat), { allowLegacyHome: false })?.provenance.kind === 'terminal'
            ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) },
        // An admitted Action owns cancellation; authorization preparation must
        // not impose a shorter lifetime on that still-current operation.
        timeout: input.signal ? 0 : 15_000,
        ...(input.signal ? { signal: input.signal } : {}),
        validateStatus: () => true,
      },
    );
  } catch (error) {
    refuseExternalActionPhase('authorization_mint_http', input.machineId, error);
    return { ok: false, code: 'server_unavailable',
      ...(!input.signal?.aborted && classifyServerEndpointError(error).retryable ? { retryable: true as const } : {}) };
  }
  if (response.status < 200 || response.status >= 300) {
    const diagnostic = readSessionInputAdmissionDiagnostic({ actionId: input.actionId, requestId: input.envelope.requestId });
    if (diagnostic) refuseExternalActionPhase('authorization_mint_http_status', input.machineId,
      createHttpStatusError(response.status, 'Home authorization unavailable'), diagnostic);
  }
  if (response.status === 403) {
    const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
    if (refusal.success && refusal.data.error === 'credential_scope_denied') {
      return { ok: false, code: 'credential_scope_denied' };
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'invalid_token' };
  }
  if (response.status === 409) {
    const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
    if (refusal.success && refusal.data.error === 'invalid_request' && refusal.data.code === 'target_unavailable') {
      return { ok: false, code: 'target_unavailable' };
    }
  }
  if ([404, 405, 501].includes(response.status)) {
    return { ok: false, code: 'server_unavailable' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: 'auth_unavailable',
      ...(classifyServerEndpointError(createHttpStatusError(response.status, 'Home authorization unavailable')).retryable
        ? { retryable: true as const } : {}) };
  }
  const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
  return authorization.success
    ? { ok: true, authorization: authorization.data }
    : { ok: false, code: 'auth_unavailable' };
}

/** Continue the accepted handoff after its original Session publisher quiesces. */
export async function prepareExternalActionHandoffContinuationAuthorization(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  handoffId: string;
  actionId: string;
  input: unknown;
  machineId: string;
  sourceMachineId: string;
  sourceInstallationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  serverHttpBaseUrl: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  return prepareExternalActionHandoffAuthorization({ ...input, phase: 'continuation' });
}

/** Read only the exact admitted peers while the original Session publisher remains current. */
export async function prepareExternalActionHandoffPreflightAuthorization(input: Omit<
  Parameters<typeof prepareExternalActionHandoffContinuationAuthorization>[0], 'handoffId' | 'actionId'
>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  return prepareExternalActionHandoffAuthorization({ ...input, phase: 'preflight', actionId: 'session.handoff' });
}

async function prepareExternalActionHandoffAuthorization(input: Omit<
  Parameters<typeof prepareExternalActionHandoffContinuationAuthorization>[0], 'handoffId'
> & Readonly<{ phase: 'preflight'; handoffId?: never } | { phase: 'continuation'; handoffId: string }>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  try {
    if (input.signal?.aborted) return null;
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
    const binding = root.binding;
    const admission = binding.handoffAdmission;
    if (binding.actionId !== 'session.handoff' || binding.handoffContinuation || binding.handoffPreflight || !admission
      || binding.machineId !== input.sourceMachineId || binding.installationId !== input.sourceInstallationId
      || admission.sourceMachineId !== input.sourceMachineId || admission.sourceInstallationId !== input.sourceInstallationId
      || ![admission.sourceMachineId, admission.targetMachineId].includes(input.machineId)) return null;
    const target = { kind: 'machine' as const, machineId: input.machineId };
    const actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
    const handoffAdmission = { sessionId: admission.sessionId, sourceMachineId: admission.sourceMachineId,
      targetMachineId: admission.targetMachineId };
    if (binding.accountEncryptionMode === 'e2ee' && !input.material) return null;
    const envelope = binding.accountEncryptionMode === 'e2ee' && input.material
      ? { ...sealExternalActionRequestV2({ binding: { serverIdentityId: binding.serverIdentityId,
          accountId: binding.accountId,
          ...('authentication' in binding ? { authentication: binding.authentication }
            : { credentialId: binding.credentialId }), actionId, requestId: binding.requestId, target },
          input: input.input, material: input.material, randomBytes }), handoffAdmission }
      : { v: 1 as const, requestId: binding.requestId, target, input: input.input, handoffAdmission };
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: input.machineId,
      envelope,
      ...(input.phase === 'preflight' ? { handoffPreflight: { authorization: root } }
        : { handoffContinuation: { authorization: root, handoffId: input.handoffId } }),
    });
    const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...createExternalActionAuthorizedRequestHeaders({ authorization: root,
        effectActionId: 'session.handoff', target: binding.target, installationId: input.sourceInstallationId,
        privateKey: input.privateKey, method: 'POST', path, body }), 'Content-Type': 'application/json' },
      timeout: input.signal ? 0 : 15_000,
      ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    if (input.signal?.aborted || response.status < 200 || response.status >= 300) return null;
    const child = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
    if (!child.success) return null;
    const next = child.data.binding;
    const expectedInstallation = input.machineId === admission.sourceMachineId
      ? admission.sourceInstallationId : admission.targetInstallationId;
    if (next.accountId !== binding.accountId || next.serverIdentityId !== binding.serverIdentityId
      || next.accountEncryptionMode !== binding.accountEncryptionMode
      || next.machineId !== input.machineId || next.installationId !== expectedInstallation
      || next.actionId !== actionId || next.requestId !== binding.requestId
      || next.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(body.envelope)
      || !externalActionTargetsEqualV1(next.target, target)
      || !sameStrictJsonValue(next.handoffAdmission, admission)
      || !sameStrictJsonValue(next.sessionActionOrigin, binding.sessionActionOrigin)
      || !sameStrictJsonValue(next.sessionActionSource, binding.sessionActionSource)
      || !sameStrictJsonValue(next.handoffContinuation, input.phase === 'preflight' ? undefined : {
        rootRequestId: binding.requestId, rootRequestEnvelopeDigest: binding.requestEnvelopeDigest, handoffId: input.handoffId })
      || !sameStrictJsonValue(next.handoffPreflight, input.phase === 'preflight' ? {
        rootRequestId: binding.requestId, rootRequestEnvelopeDigest: binding.requestEnvelopeDigest } : undefined)
      || ('authentication' in binding ? !('authentication' in next)
        || !sameStrictJsonValue(next.authentication, binding.authentication)
        : !('credentialId' in next) || next.credentialId !== binding.credentialId
          || next.principalId !== binding.principalId || !sameStrictJsonValue(next.grant, binding.grant))) return null;
    return child.data;
  } catch (error) { refuseExternalActionPhase('handoff_authorization', input.machineId, error); return null; }
}

export async function verifyExternalActionExecutionAuthorizationCurrent(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  privateKey: ExternalActionMachineRequestSigningKey;
  installationId: string;
  serverHttpBaseUrl: string;
  managedFiniteWakeTarget?: ManagedWakeTargetV1;
  retainedDiscussionSource?: SessionInputSourceSessionV1;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(
    input.authorization.binding.actionId,
  );
  const body = { v: 1 as const, ...(input.managedFiniteWakeTarget ? { managedFiniteWakeTarget: input.managedFiniteWakeTarget } : {}),
    ...(input.retainedDiscussionSource ? { retainedDiscussionSource: input.retainedDiscussionSource } : {}) };
  const headers = createExternalActionAuthorizedRequestHeaders({
    authorization: input.authorization,
    effectActionId: input.effectActionId,
    target: input.target,
    installationId: input.installationId,
    method: 'POST',
    path,
    body,
    privateKey: input.privateKey,
  });
  try {
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: input.signal ? 0 : 15_000,
      ...(input.signal ? { signal: input.signal } : {}),
      validateStatus: () => true,
    });
    traceExternalActionInnerStage('requester.root_verification.http', { httpStatus: response.status });
    if (response.status < 200 || response.status >= 300) {
      const failure = createHttpStatusError(response.status, 'External Action authorization is unavailable');
      refuseExternalActionPhase('signed_root_http_status', input.authorization.binding.machineId, failure,
        readSessionInputAdmissionDiagnostic(input.authorization.binding));
      rethrowRequesterHomeReadFailure(failure);
      return false;
    }
    const parsed = ExternalActionExecutionAuthorizationVerifyResponseV1Schema.safeParse(response.data);
    if (!parsed.success) refuseExternalActionPhase('signed_root_http_response', input.authorization.binding.machineId, parsed.error);
    return parsed.success;
  } catch (error) {
    refuseExternalActionPhase('signed_root_http_request', input.authorization.binding.machineId, error);
    rethrowRequesterHomeReadFailure(error);
    return false;
  }
}
