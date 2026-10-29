import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';
import { deriveAccountScopedArtifactIdV1, resolveAccountScopedArtifactIdV1, type ArtifactIdScopeV1 } from '../artifacts/idScope.js';
import { encodeExternalActionResolvedTargetV1 } from '../actions/externalActionExecutionAuthorization.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1, type ApprovalArtifactHeaderV1 } from './approvalArtifactHeaderV1.js';
import type { ApprovalRequest, ApprovalRequestV2 } from './approvalRequestV1.js';
import { settleApprovalRequestReplayInputs } from './approvalRequestTransition.js';
import type { TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';
import { targetActionApprovalSubjectsEqual } from './targetActionApprovalRequestTransition.js';

type StoredArtifact = Readonly<{ header: Readonly<Record<string, unknown>>; body: unknown; access?: string }>;
type CreationRequest = ApprovalRequest | TargetActionApprovalRequestV1;
type CapturedRequest = ApprovalRequestV2 | TargetActionApprovalRequestV1;

function isTargetActionRequest(request: CreationRequest): request is TargetActionApprovalRequestV1 {
  return 'kind' in request && request.kind === 'plugin_target_action';
}

function requestIdentity(request: CreationRequest): CapturedRequest | null {
  if (!isTargetActionRequest(request)) return request.v === 2 ? request : null;
  return request.executionOriginV1 ? request : null;
}

export class ApprovalRequestConflict extends Error {
  readonly code = 'approval_request_conflict';
  constructor() { super('approval_request_conflict'); }
}

/** Identity contains no Action operands, titles, or credential material. */
function deriveApprovalRequestSourceId(request: CapturedRequest, accountId?: string | null): string {
  const origin = request.executionOriginV1;
  if (!origin) throw new ApprovalRequestConflict();
  // Receipt execution placement, not the requesting Session or display header.
  const target = origin.target ?? (origin.machineId ? { kind: 'machine' as const, machineId: origin.machineId }
    : origin.sessionId ? { kind: 'session' as const, sessionId: origin.sessionId } : null);
  const digest = computeCanonicalDomainSeparatedHexDigest('happier.approval.request-identity.v1', [
    origin.serverIdentityId ?? origin.serverId,
    accountId ?? origin.accountId ?? '',
    request.requesterConfirmation?.requesterAccountId ?? origin.principalId ?? origin.accountId ?? '',
    origin.requestId,
    isTargetActionRequest(request) ? request.qualifiedActionId : request.actionId,
    target ? encodeExternalActionResolvedTargetV1(target) : '',
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

/** Domain draft/install identity cannot substitute a captured request's operands. */
export function assertApprovalRequestCreationBinding(request: ApprovalRequestV2, proposed: ApprovalRequestV2): void {
  // A terminal receipt no longer retains replay-only operands or its original
  // envelope. Compare the proposal through the same canonical settlement owner.
  const subject = request.status === 'open' || request.status === 'approved' || request.status === 'executing'
    ? proposed : settleApprovalRequestReplayInputs(proposed);
  if (subject.v !== 2) throw new ApprovalRequestConflict();
  if (request.actionId !== proposed.actionId
    || request.requestInputDigest !== proposed.requestInputDigest
    || !sameStrictJsonValue(request.actionArgs, subject.actionArgs)
    || !sameStrictJsonValue(originSubject(request.executionOriginV1), originSubject(subject.executionOriginV1))
    || !sameStrictJsonValue(request.requesterConfirmation ?? null, proposed.requesterConfirmation ?? null)
    || !sameStrictJsonValue(request.createdBy, proposed.createdBy)) {
    throw new ApprovalRequestConflict();
  }
}

function rejoin(stored: StoredArtifact | null, proposed: CreationRequest): CreationRequest {
  const parsed = stored && typeof stored.body === 'string'
    ? approvalArtifactBodyMatchesHeaderV1(stored.header, stored.body) : null;
  if (!parsed || stored?.access !== 'owner') throw new ApprovalRequestConflict();
  if (isTargetActionRequest(proposed)) {
    const existing = parsed.family === 'target_action' ? parsed.request : null;
    if (!existing?.executionOriginV1 || !proposed.executionOriginV1
      || !sameStrictJsonValue(originSubject(existing.executionOriginV1), originSubject(proposed.executionOriginV1))
      || !targetActionApprovalSubjectsEqual(existing, { ...proposed,
        createdAtMs: existing.createdAtMs, summary: existing.summary, detail: existing.detail,
        // Profile aliases are routing hints, not a second Home identity.
        ...(existing.replayPlacement && proposed.replayPlacement
          && existing.executionOriginV1.serverIdentityId
          && existing.executionOriginV1.serverIdentityId === proposed.executionOriginV1.serverIdentityId
          ? { replayPlacement: { ...proposed.replayPlacement, serverId: existing.replayPlacement.serverId } } : {}),
        executionOriginV1: existing.executionOriginV1 })) throw new ApprovalRequestConflict();
    return existing;
  }
  const request = parsed?.family === 'built_in' && parsed.request.v === 2 ? parsed.request : null;
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
type CreationInput<Request extends CreationRequest> = Readonly<{
  request: Request;
  accountId?: string | null;
  serverId?: string | null;
  newId: () => string;
  read: (artifactId: string) => Promise<StoredArtifact | null>;
  create: (artifactId: string, header: ApprovalArtifactHeaderV1, body: string, idScope?: ArtifactIdScopeV1) => Promise<StoredArtifact | void>;
}>;

export function createApprovalRequestArtifact(input: CreationInput<ApprovalRequest>): Promise<Readonly<{ artifactId: string; request: ApprovalRequest }>>;
export function createApprovalRequestArtifact(input: CreationInput<TargetActionApprovalRequestV1>): Promise<Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>>;
export async function createApprovalRequestArtifact(input: CreationInput<CreationRequest>): Promise<Readonly<{ artifactId: string; request: CreationRequest }>> {
  const { request } = input;
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
