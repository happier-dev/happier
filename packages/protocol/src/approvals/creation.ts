import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';
import type { ApprovalRequestConflictFieldV1 } from '../actions/actionExecutionResult.js';
import { deriveAccountScopedArtifactIdV1, resolveAccountScopedArtifactIdV1, type ArtifactIdScopeV1 } from '../artifacts/idScope.js';
import { encodeExternalActionResolvedTargetV1 } from '../actions/externalActionExecutionAuthorization.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1, type ApprovalArtifactHeaderV1 } from './approvalArtifactHeaderV1.js';
import { ApprovalRequestSchema, isHistoricalPublishApprovalRequestV2, type ApprovalRequest, type CurrentApprovalRequest, type ApprovalRequestV2 } from './approvalRequestV1.js';
import { settleApprovalRequestReplayInputs } from './approvalRequestTransition.js';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';
import { targetActionApprovalSubjectsEqual, settleTargetActionApprovalReplayInputs } from './targetActionApprovalRequestTransition.js';

type StoredArtifact = Readonly<{ header: Readonly<Record<string, unknown>>; body: unknown; access?: string }>;
type CreationRequest = CurrentApprovalRequest | TargetActionApprovalRequestV1;
type CapturedRequest = ApprovalRequestV2 | TargetActionApprovalRequestV1;
type ApprovalCreationIssue = Readonly<{ code: string; path: readonly PropertyKey[]; message: string }>;

function isTargetActionRequest(request: ApprovalRequest | TargetActionApprovalRequestV1): request is TargetActionApprovalRequestV1 {
  return 'kind' in request && request.kind === 'plugin_target_action';
}

function requestIdentity(request: CreationRequest): CapturedRequest | null {
  if (!isTargetActionRequest(request)) return request.v === 2 ? request : null;
  return request.executionOriginV1 ? request : null;
}

export class ApprovalRequestConflict extends Error {
  readonly code = 'approval_request_conflict';
  readonly details?: Readonly<{ mismatches: readonly ApprovalRequestConflictFieldV1[] }>;
  constructor(mismatches?: readonly ApprovalRequestConflictFieldV1[]) {
    super('approval_request_conflict');
    if (mismatches) this.details = { mismatches };
  }
}

export class ApprovalRequestInvalid extends Error {
  readonly code = 'approval_invalid';
  readonly details: Readonly<{ issues: readonly ApprovalCreationIssue[] }>;
  constructor(issues: readonly ApprovalCreationIssue[]) {
    super('approval_invalid');
    // Never include Zod's input, native error objects or the approval payload.
    this.details = { issues: issues.map(({ code, path, message }) => ({ code, path, message })) };
  }
}

type PluginPublicationApprovalSubject = Readonly<{
  home: string; accountId: string; machineId: string; pluginId: string; contributionLocalId: string;
  actionId: RetainedPluginObligationActionId; localId: string; requestInputDigest: ApprovalRequestV2['requestInputDigest'];
}>;
/** Actions whose plugin caller retries one input-carried obligation (see `readRetainedPluginObligationKey`). */
export const RETAINED_PLUGIN_OBLIGATION_ACTION_IDS = ['discussion.post', 'discussion.reply', 'automation.event.admit'] as const;
type RetainedPluginObligationActionId = typeof RETAINED_PLUGIN_OBLIGATION_ACTION_IDS[number];
function isRetainedPluginObligationActionId(actionId: string): actionId is RetainedPluginObligationActionId {
  return (RETAINED_PLUGIN_OBLIGATION_ACTION_IDS as readonly string[]).includes(actionId);
}

/**
 * The input-carried obligation key of an Action whose plugin caller retries
 * one obligation: a Discussion publication's `localId`, or an Event
 * occurrence (its event and occurrence id). Every other input still binds
 * through the request input digest.
 */
function readRetainedPluginObligationKey(actionId: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  if (actionId === 'discussion.post' || actionId === 'discussion.reply') {
    // Attachment paths belong to this attempt's temporary files, not the retained obligation.
    if ('attachmentSources' in input && Array.isArray(input.attachmentSources) && input.attachmentSources.length > 0) return null;
    const localId = 'localId' in input ? input.localId : undefined;
    return typeof localId === 'string' && localId.trim() ? localId : null;
  }
  if (actionId !== 'automation.event.admit') return null;
  const eventRef = 'eventRef' in input ? input.eventRef : undefined;
  const occurrenceId = 'occurrenceId' in input ? input.occurrenceId : undefined;
  if (!eventRef || typeof eventRef !== 'object' || typeof occurrenceId !== 'string' || !occurrenceId) return null;
  const pluginId = 'pluginId' in eventRef ? eventRef.pluginId : undefined;
  const localId = 'localId' in eventRef ? eventRef.localId : undefined;
  return typeof pluginId === 'string' && typeof localId === 'string'
    ? JSON.stringify(['event_occurrence', pluginId, localId, occurrenceId]) : null;
}

/** A retained plugin obligation belongs to its input key, not its executable generation or attempt. */
export function readPluginPublicationApprovalSubject(request: CreationRequest): PluginPublicationApprovalSubject | null {
  if (isTargetActionRequest(request) || request.v !== 2 || request.approval?.flow !== 'blocking') return null;
  return readRetainedPluginObligationSubject(request);
}

function readRetainedPluginObligationSubject(request: ApprovalRequestV2): PluginPublicationApprovalSubject | null {
  const actionId = request.actionId;
  if (!isRetainedPluginObligationActionId(actionId)) return null;
  const origin = request.executionOriginV1;
  if (origin.surface !== 'plugin' || origin.authority !== 'account_automation' || origin.caller.kind !== 'plugin'
    || !origin.accountId || !origin.machineId || !origin.caller.contributionLocalId
    || origin.externalActionExecutionAuthorization || origin.discussionReplyReturn) return null;
  const localId = readRetainedPluginObligationKey(actionId, request.actionArgs);
  if (localId === null) return null;
  return { home: origin.serverIdentityId ?? origin.serverId, accountId: origin.accountId, machineId: origin.machineId,
    pluginId: origin.caller.pluginId, contributionLocalId: origin.caller.contributionLocalId,
    actionId, localId, requestInputDigest: request.requestInputDigest };
}

/** Identity contains no Action operands, titles, or credential material. */
function deriveApprovalRequestSourceId(request: CapturedRequest, accountId?: string | null): string {
  const origin = request.executionOriginV1;
  if (!origin) throw new ApprovalRequestInvalid([{ code: 'custom', path: ['executionOriginV1'], message: 'Approval request identity requires its execution origin' }]);
  return deriveApprovalRequestSourceIdForSubject(request, origin, readPluginPublicationApprovalSubject(request), accountId);
}

function deriveApprovalRequestSourceIdForSubject(request: CapturedRequest, origin: NonNullable<CapturedRequest['executionOriginV1']>,
  publication: PluginPublicationApprovalSubject | null, accountId?: string | null): string {
  // Receipt execution placement, not the requesting Session or display header.
  const target = origin.target ?? (origin.machineId ? { kind: 'machine' as const, machineId: origin.machineId }
    : origin.sessionId ? { kind: 'session' as const, sessionId: origin.sessionId } : null);
  return deriveApprovalRequestSourceIdFromIdentityV1({ homeId: origin.serverIdentityId ?? origin.serverId,
    accountId: accountId ?? origin.accountId ?? '',
    requesterId: request.requesterConfirmation?.requesterAccountId ?? origin.principalId ?? origin.accountId ?? '',
    requestId: publication ? JSON.stringify(['plugin_publication', publication.pluginId, publication.contributionLocalId, publication.localId, publication.requestInputDigest]) : origin.requestId,
    actionId: isTargetActionRequest(request) ? request.qualifiedActionId : request.actionId,
    target });
}

/** Home and the Artifact creation owner share the same non-content identity. */
export function deriveApprovalRequestSourceIdFromIdentityV1(input: Readonly<{
  homeId: string; accountId: string; requesterId: string; requestId: string; actionId: string;
  target: Parameters<typeof encodeExternalActionResolvedTargetV1>[0] | null;
}>): string {
  const digest = computeCanonicalDomainSeparatedHexDigest('happier.approval.request-identity.v1', [
    input.homeId, input.accountId, input.requesterId, input.requestId, input.actionId,
    input.target ? encodeExternalActionResolvedTargetV1(input.target) : '',
  ]);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function deriveApprovalRequestArtifactId(request: CapturedRequest, accountId?: string | null): string {
  return deriveAccountScopedArtifactIdV1(accountId ?? request.executionOriginV1?.accountId ?? '',
    deriveApprovalRequestSourceId(request, accountId));
}

function originSubject(executionOrigin: ApprovalRequestV2['executionOriginV1']) {
  const { serverId, serverIdentityId, externalActionExecutionAuthorization, ...origin } = executionOrigin;
  return { ...origin, home: serverIdentityId ?? serverId,
    ...(externalActionExecutionAuthorization ? { authorization: externalActionExecutionAuthorization.binding } : {}) };
}

function creationOriginSubject(request: ApprovalRequestV2) {
  const origin = originSubject(request.executionOriginV1);
  const publication = readPluginPublicationApprovalSubject(request);
  if (!publication || origin.caller.kind !== 'plugin') return origin;
  const { sourceCustody: _sourceCustody, ...caller } = origin.caller;
  // Creation alone may transfer live custody. The stored origin and the later
  // decision remain untouched; every other captured fact still compares exactly.
  return { ...origin, requestId: publication.localId, caller };
}

/** Domain draft/install identity cannot substitute a captured request's operands. */
export function assertApprovalRequestCreationBinding(request: ApprovalRequestV2, proposed: ApprovalRequestV2): void {
  // A terminal receipt no longer retains replay-only operands or its original
  // envelope. Compare the proposal through the same canonical settlement owner.
  const subject = request.status === 'open' || request.status === 'approved' || request.status === 'executing'
    ? proposed : settleApprovalRequestReplayInputs(proposed);
  if (subject.v !== 2) throw new ApprovalRequestConflict(['v']);
  // Report only field names: captured operands, origin proofs and credentials stay private.
  const mismatches: ApprovalRequestConflictFieldV1[] = [];
  if (request.actionId !== proposed.actionId) mismatches.push('actionId');
  if (request.requestInputDigest !== proposed.requestInputDigest) mismatches.push('requestInputDigest');
  if (!sameStrictJsonValue(request.actionArgs, subject.actionArgs, { omitUndefinedObjectMembers: true }))
    mismatches.push('actionArgs');
  if (!sameStrictJsonValue(creationOriginSubject(request), creationOriginSubject(subject)))
    mismatches.push('executionOriginV1');
  if (!sameStrictJsonValue(request.requesterConfirmation ?? null, proposed.requesterConfirmation ?? null))
    mismatches.push('requesterConfirmation');
  if (!sameStrictJsonValue(request.createdBy, proposed.createdBy)) mismatches.push('createdBy');
  if (mismatches.length > 0) throw new ApprovalRequestConflict(mismatches);
}

function rejoin(stored: StoredArtifact | null, proposed: CreationRequest): CreationRequest {
  const parsed = stored && typeof stored.body === 'string'
    ? approvalArtifactBodyMatchesHeaderV1(stored.header, stored.body) : null;
  if (!parsed || stored?.access !== 'owner') throw new ApprovalRequestInvalid([{ code: 'custom', path: [],
    message: 'Approval creation requires a readable owned Artifact with a matching body and header' }]);
  if (isTargetActionRequest(proposed)) {
    const existing = parsed.family === 'target_action' ? parsed.request : null;
    if (!existing?.executionOriginV1 || !proposed.executionOriginV1) throw new ApprovalRequestConflict();
    const receipt = settleTargetActionApprovalReplayInputs(existing);
    const subject = settleTargetActionApprovalReplayInputs(proposed, existing.status);
    // Settlement preserves each origin's binding, erasing only its original envelope.
    if (!sameStrictJsonValue(originSubject(receipt.executionOriginV1!), originSubject(subject.executionOriginV1!))
      || !targetActionApprovalSubjectsEqual(receipt, { ...subject,
        createdAtMs: existing.createdAtMs, summary: existing.summary, detail: existing.detail,
        // Profile aliases are routing hints, not a second Home identity.
        ...(existing.replayPlacement && proposed.replayPlacement
          && existing.executionOriginV1.serverIdentityId
          && existing.executionOriginV1.serverIdentityId === proposed.executionOriginV1.serverIdentityId
          ? { replayPlacement: { ...proposed.replayPlacement, serverId: existing.replayPlacement.serverId } } : {}),
        executionOriginV1: receipt.executionOriginV1 })) throw new ApprovalRequestConflict();
    return existing;
  }
  const request = parsed?.family === 'built_in' && parsed.request.v === 2
    && !isHistoricalPublishApprovalRequestV2(parsed.request) ? parsed.request : null;
  if (!request || proposed.v !== 2) throw new ApprovalRequestConflict();
  assertApprovalRequestCreationBinding(request, proposed);
  return request;
}

async function readExisting(read: (artifactId: string) => Promise<StoredArtifact | null>, artifactId: string) {
  try { return await read(artifactId); }
  catch (error) {
    if (error && typeof error === 'object') {
      const details = Reflect.get(error, 'details');
      const status = Reflect.get(error, 'status') ?? (details && typeof details === 'object' ? Reflect.get(details, 'httpStatus') : undefined);
      const code = Reflect.get(error, 'code') ?? Reflect.get(error, 'errorCode');
      // Some Artifact transports expose the typed HTTP miss rather than null.
      // This applies only to the exact existence read, never to creation errors.
      if (code === 'not_found' && status === 404) return null;
    }
    throw error;
  }
}

/**
 * One creation owner for UI and CLI. The private Artifact's existing exact-id
 * create is the atomic winner; its opened stored bytes bind every rejoin.
 * There is no inventory scan or process-local deduplication state.
 */
type CreationInput<Request extends ApprovalRequest | TargetActionApprovalRequestV1> = Readonly<{
  request: Request;
  accountId?: string | null;
  serverId?: string | null;
  newId: () => string;
  read: (artifactId: string) => Promise<StoredArtifact | null>;
  create: (artifactId: string, header: ApprovalArtifactHeaderV1, body: string, idScope?: ArtifactIdScopeV1) => Promise<StoredArtifact | void>;
}>;

export function createApprovalRequestArtifact(input: CreationInput<ApprovalRequest>): Promise<Readonly<{ artifactId: string; request: CurrentApprovalRequest }>>;
export function createApprovalRequestArtifact(input: CreationInput<TargetActionApprovalRequestV1>): Promise<Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>>;
export async function createApprovalRequestArtifact(input: CreationInput<ApprovalRequest | TargetActionApprovalRequestV1>): Promise<Readonly<{ artifactId: string; request: CreationRequest }>> {
  const parsed = isTargetActionRequest(input.request)
    ? TargetActionApprovalRequestV1Schema.safeParse(input.request)
    : ApprovalRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new ApprovalRequestInvalid(parsed.error.issues);
  const request = parsed.data;
  const identity = requestIdentity(request);
  const resolved = identity ? await resolveAccountScopedArtifactIdV1({
    accountId: input.accountId ?? identity.executionOriginV1?.accountId ?? '',
    sourceId: deriveApprovalRequestSourceId(identity, input.accountId),
    read: artifactId => readExisting(input.read, artifactId),
  }) : { artifactId: input.newId(), idScope: undefined, artifact: null };
  const { artifactId, idScope } = resolved;
  if (resolved.artifact) return { artifactId, request: rejoin(resolved.artifact, request) };
  let created: StoredArtifact | void = undefined;
  try {
    const header = isTargetActionRequest(request) ? buildTargetActionApprovalArtifactHeaderV1(request)
      : buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: input.serverId });
    created = await input.create(artifactId, header, JSON.stringify(request), idScope);
  } catch (error) {
    // A competing exact-id create can win between the read and the write.
    // Reconcile that one winner; never retry creation or overwrite its body.
    if (!identity || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'conflict') throw error;
  }
  // Home may return its incumbent row with HTTP 200. Reading its authoritative
  // content is required even when create succeeded, especially with fresh E2EE keys.
  return { artifactId, request: identity ? rejoin(created ?? await readExisting(input.read, artifactId), request) : request };
}
