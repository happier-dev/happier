import { StoredApprovalRequestSchema, type ApprovalRequest } from './approvalRequestV1.js';
import { APPROVAL_ARTIFACT_KINDS_V1 } from './approvalArtifactKindV1.js';
import {
  StoredExecutionRunHostActionApprovalRequestV1Schema,
  type ExecutionRunHostActionApprovalRequestV1,
} from './executionRunHostActionApprovalRequestV1.js';
import {
  StoredTargetActionApprovalRequestV1Schema,
  type TargetActionApprovalRequestV1,
} from './targetActionApprovalRequestV1.js';

/**
 * What the three builders below actually produce: an Artifact index header that
 * always carries the human title, plus the family-specific binding fields the
 * matchers re-check. Artifact stores require the title, so it is declared rather
 * than left to the passthrough index signature.
 */
export type ApprovalArtifactHeaderV1 = Readonly<{ title: string } & Record<string, unknown>>;

/**
 * What a reader may be handed: any stored Artifact header, including one this
 * version never wrote. Nothing is assumed about it before the matchers agree.
 */
export type ApprovalArtifactHeaderCandidateV1 = Readonly<Record<string, unknown>>;

export type ParsedApprovalArtifactBodyV1 =
  | Readonly<{ family: 'built_in'; request: ApprovalRequest }>
  | Readonly<{ family: 'target_action'; request: TargetActionApprovalRequestV1 }>
  | Readonly<{ family: 'execution_run_host_action'; request: ExecutionRunHostActionApprovalRequestV1 }>;

function optionalExactStringMatches(actual: unknown, expected: string | null): boolean {
  return expected === null
    ? actual === undefined || actual === null
    : actual === expected;
}

function sessionBindingMatches(header: ApprovalArtifactHeaderCandidateV1, sessionId: string | null): boolean {
  return optionalExactStringMatches(header.sessionId, sessionId)
    && (sessionId
      ? Array.isArray(header.sessions) && header.sessions.length === 1 && header.sessions[0] === sessionId
      : header.sessions === undefined || header.sessions === null);
}

export function buildApprovalRequestArtifactHeaderV1(
  request: ApprovalRequest,
  options: Readonly<{ legacyServerId?: string | null }> = {},
): ApprovalArtifactHeaderV1 {
  const origin = request.v === 2 ? request.executionOriginV1 : null;
  const sessionId = origin?.sessionId
    ?? (typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '');
  const legacyServerId = options.legacyServerId?.trim() || null;
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
    ...(origin ? { serverId: origin.serverId } : legacyServerId ? { serverId: legacyServerId } : {}),
    ...(origin?.serverIdentityId ? { serverIdentityId: origin.serverIdentityId } : {}),
    ...(origin?.machineId ? { machineId: origin.machineId } : {}),
    ...(origin?.runId ? { runId: origin.runId } : {}),
    ...(origin?.runOccurrenceId ? { runOccurrenceId: origin.runOccurrenceId } : {}),
  };
}

export function approvalRequestArtifactHeaderMatches(
  header: ApprovalArtifactHeaderCandidateV1,
  request: ApprovalRequest,
): boolean {
  const origin = request.v === 2 ? request.executionOriginV1 : null;
  const sessionId = origin?.sessionId
    ?? (typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '');
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.actionId === request.actionId
    && sessionBindingMatches(header, sessionId || null)
    && (request.v === 1 || (
      optionalExactStringMatches(header.serverId, origin?.serverId ?? null)
      && optionalExactStringMatches(header.serverIdentityId, origin?.serverIdentityId ?? null)
      && optionalExactStringMatches(header.machineId, origin?.machineId ?? null)
      && optionalExactStringMatches(header.runId, origin?.runId ?? null)
      && optionalExactStringMatches(header.runOccurrenceId, origin?.runOccurrenceId ?? null)
    ));
}

export function buildTargetActionApprovalArtifactHeaderV1(
  request: TargetActionApprovalRequestV1,
): ApprovalArtifactHeaderV1 {
  const origin = request.executionOriginV1;
  const sessionId = origin?.sessionId
    ?? request.replayPlacement?.defaultSessionId
    ?? request.createdBy.sessionId
    ?? null;
  const serverId = origin?.serverId ?? request.replayPlacement?.serverId ?? null;
  const machineId = origin?.machineId ?? request.replayPlacement?.machineId ?? null;
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.targetAction,
    title: request.summary,
    approvalStatus: request.status,
    qualifiedActionId: request.qualifiedActionId,
    subjectFingerprint: request.subjectFingerprint,
    ...(serverId ? { serverId } : {}),
    ...(origin?.serverIdentityId ? { serverIdentityId: origin.serverIdentityId } : {}),
    ...(machineId ? { machineId } : {}),
    ...(origin?.runId ? { runId: origin.runId } : {}),
    ...(origin?.runOccurrenceId ? { runOccurrenceId: origin.runOccurrenceId } : {}),
    ...(sessionId ? { sessionId, sessions: [sessionId] } : {}),
  };
}

export function targetActionApprovalArtifactHeaderMatches(
  header: ApprovalArtifactHeaderCandidateV1,
  request: TargetActionApprovalRequestV1,
): boolean {
  const origin = request.executionOriginV1;
  const placement = request.replayPlacement;
  const sessionId = origin?.sessionId ?? placement?.defaultSessionId ?? request.createdBy.sessionId ?? null;
  const serverId = origin?.serverId ?? placement?.serverId ?? null;
  const machineId = origin?.machineId ?? placement?.machineId ?? null;
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.qualifiedActionId === request.qualifiedActionId
    && header.subjectFingerprint === request.subjectFingerprint
    && optionalExactStringMatches(header.serverId, serverId)
    && optionalExactStringMatches(header.serverIdentityId, origin?.serverIdentityId ?? null)
    && optionalExactStringMatches(header.machineId, machineId)
    && optionalExactStringMatches(header.runId, origin?.runId ?? null)
    && optionalExactStringMatches(header.runOccurrenceId, origin?.runOccurrenceId ?? null)
    && sessionBindingMatches(header, sessionId);
}

export function buildExecutionRunHostActionApprovalArtifactHeaderV1(
  request: ExecutionRunHostActionApprovalRequestV1,
): ApprovalArtifactHeaderV1 {
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction,
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    sessionId: request.sessionId,
    sessions: [request.sessionId],
    runId: request.runId,
    profileId: request.profileId,
    subjectFingerprint: request.subjectFingerprint,
    serverId: request.serverId,
  };
}

export function executionRunHostActionApprovalArtifactHeaderMatches(
  header: ApprovalArtifactHeaderCandidateV1,
  request: ExecutionRunHostActionApprovalRequestV1,
): boolean {
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.actionId === request.actionId
    && header.runId === request.runId
    && header.profileId === request.profileId
    && header.subjectFingerprint === request.subjectFingerprint
    && optionalExactStringMatches(header.serverId, request.serverId)
    && sessionBindingMatches(header, request.sessionId);
}

/**
 * Canonical body-authoritative approval Artifact reader. The header is only an
 * index: callers must hydrate the body and accept the Artifact only when the
 * strict family schema and every duplicated header field agree.
 */
export function approvalArtifactBodyMatchesHeaderV1(
  header: ApprovalArtifactHeaderCandidateV1,
  body: string | null | undefined,
): ParsedApprovalArtifactBodyV1 | null {
  if (typeof body !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  if (header.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn) {
    const parsed = StoredApprovalRequestSchema.safeParse(value);
    return parsed.success && approvalRequestArtifactHeaderMatches(header, parsed.data)
      ? { family: 'built_in', request: parsed.data }
      : null;
  }
  if (header.kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction) {
    const parsed = StoredTargetActionApprovalRequestV1Schema.safeParse(value);
    return parsed.success && targetActionApprovalArtifactHeaderMatches(header, parsed.data)
      ? { family: 'target_action', request: parsed.data }
      : null;
  }
  if (header.kind === APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction) {
    const parsed = StoredExecutionRunHostActionApprovalRequestV1Schema.safeParse(value);
    return parsed.success && executionRunHostActionApprovalArtifactHeaderMatches(header, parsed.data)
      ? { family: 'execution_run_host_action', request: parsed.data }
      : null;
  }
  return null;
}
