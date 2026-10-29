import { StoredApprovalRequestSchema, type ApprovalRequest } from './approvalRequestV1.js';
import { APPROVAL_ARTIFACT_KINDS_V1 } from './approvalArtifactKindV1.js';
import { ActionIdSchema, type ActionId } from '../actions/actionIds.js';
import type { ApprovalQueueListItemV1, ApprovalQueueListResultV1 } from '../actions/executor/types.js';
import type { ArtifactListSelectionOptionsV1 } from '../artifacts/artifactListSelectionV1.js';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '../local/services/launcher/v1.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { ManagedDeleteInputV1Schema } from '../machines/managed/actionsV1.js';
import { isApiTokenGrantTargetMemberV1, type ApiTokenGrantV1 } from '../auth/apiTokenGrant.js';
import type { ExternalActionTargetV1 } from '../actions/externalActionApi.js';
export { APPROVAL_ARTIFACT_KINDS_V1 } from './approvalArtifactKindV1.js';
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

/** The surrounding private Artifact inventory and verified origin supply Home/Account scope. */
export function deriveProjectServiceStartApprovalSubjectKeyV1(source: Readonly<{ machineId: string; refId: string }>): string {
  return `project-service-start:${computeCanonicalDomainSeparatedDigest('happier.approval.project-service-start-subject.v1', [source.machineId, source.refId])}`;
}

export function deriveManagedDeleteApprovalSubjectKeyV1(input: Readonly<{ homeId: string; managedId: string }>): string {
  return `managed-delete:${computeCanonicalDomainSeparatedDigest('happier.approval.managed-delete-subject.v1', [input.homeId, input.managedId])}`;
}

/** One subject-index producer; a header hint never substitutes for body admission. */
export function readApprovalRequestArtifactSubjectKeyV1(request: ApprovalRequest): string | null {
  if (request.v === 2 && request.actionId === 'localServices.launcher.start') {
    const input = DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(request.actionArgs);
    return input.success && input.data.workspace && input.data.declaration?.selection.kind === 'manifest'
      && input.data.declaration.workspaceRefId === input.data.workspace.workspaceId
      ? deriveProjectServiceStartApprovalSubjectKeyV1({ machineId: input.data.workspace.machineId, refId: input.data.declaration.workspaceRefId }) : null;
  }
  if (request.actionId !== 'machines.managed.delete') return null;
  const input = ManagedDeleteInputV1Schema.safeParse(request.actionArgs);
  return input.success ? deriveManagedDeleteApprovalSubjectKeyV1(input.data) : null;
}

export function managedDeleteApprovalIndexedKindV1(subjectKey: string): string {
  return `${APPROVAL_ARTIFACT_KINDS_V1.builtIn}#${subjectKey}`;
}

export function buildApprovalRequestArtifactHeaderV1(
  request: ApprovalRequest,
  options: Readonly<{ legacyServerId?: string | null }> = {},
): ApprovalArtifactHeaderV1 {
  const origin = request.v === 2 ? request.executionOriginV1 : null;
  const sessionId = origin?.sessionId
    ?? (typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '');
  const legacyServerId = options.legacyServerId?.trim() || null;
  const approvalSubjectKey = readApprovalRequestArtifactSubjectKeyV1(request);
  const targetKind = approvalObservationTargetKind(origin?.target, sessionId, origin?.machineId);
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    ...(targetKind ? { approvalTargetKind: targetKind } : {}),
    ...(approvalSubjectKey ? { approvalSubjectKey } : {}),
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
  const approvalSubjectKey = readApprovalRequestArtifactSubjectKeyV1(request);
  return header.v === 1
    && header.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn
    && header.title === request.summary
    && header.approvalStatus === request.status
    && header.actionId === request.actionId
    && (header.approvalTargetKind === undefined
      || header.approvalTargetKind === approvalObservationTargetKind(origin?.target, sessionId, origin?.machineId))
    && (request.actionId === 'localServices.launcher.start' && header.approvalSubjectKey === undefined
      || optionalExactStringMatches(header.approvalSubjectKey, approvalSubjectKey))
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
  const targetKind = approvalObservationTargetKind(origin?.target, sessionId, machineId);
  return {
    v: 1,
    kind: APPROVAL_ARTIFACT_KINDS_V1.targetAction,
    title: request.summary,
    approvalStatus: request.status,
    qualifiedActionId: request.qualifiedActionId,
    ...(targetKind ? { approvalTargetKind: targetKind } : {}),
    subjectFingerprint: request.subjectFingerprint,
    ...(serverId ? { serverId } : {}),
    ...(origin?.serverIdentityId ? { serverIdentityId: origin.serverIdentityId } : {}),
    ...(machineId ? { machineId } : {}),
    ...(origin?.runId ? { runId: origin.runId } : {}),
    ...(origin?.runOccurrenceId ? { runOccurrenceId: origin.runOccurrenceId } : {}),
    ...(sessionId ? { sessionId, sessions: [sessionId] } : {}),
  };
}

/** Canonical Session binding shared by private indexing and target-bound public reads. */
export function readApprovalArtifactSessionIdV1(
  request: ApprovalRequest | TargetActionApprovalRequestV1,
): string | null {
  const parsed = readApprovalArtifactObservationRequestV1(request);
  return parsed ? readApprovalArtifactObservationSubjectV1(parsed).sessionId : null;
}

type ApprovalObservationRequestV1 = Exclude<ParsedApprovalArtifactBodyV1, { family: 'execution_run_host_action' }>;

/** Exact reads admit their stored family once; list reads already carry this discriminator. */
export function readApprovalArtifactObservationRequestV1(
  request: ParsedApprovalArtifactBodyV1['request'],
): ApprovalObservationRequestV1 | null {
  const target = StoredTargetActionApprovalRequestV1Schema.safeParse(request);
  if (target.success) return { family: 'target_action', request: target.data };
  const approval = StoredApprovalRequestSchema.safeParse(request);
  return approval.success ? { family: 'built_in', request: approval.data } : null;
}

function approvalHeaderTarget(header: ApprovalArtifactHeaderCandidateV1): ExternalActionTargetV1 | null {
  if (header.approvalTargetKind !== undefined && header.approvalTargetKind !== 'session' && header.approvalTargetKind !== 'machine') return null;
  return header.approvalTargetKind !== 'machine' && typeof header.sessionId === 'string' && header.sessionId
    ? { kind: 'session', sessionId: header.sessionId }
    : header.approvalTargetKind !== 'session' && typeof header.machineId === 'string' && header.machineId
      ? { kind: 'machine', machineId: header.machineId } : null;
}

/** Project subject kind separately from the requesting Session and execution placement. */
function approvalObservationTargetKind(target: ExternalActionTargetV1 | undefined, sessionId: string | null | undefined,
  machineId: string | null | undefined) {
  return (target ?? approvalHeaderTarget({ sessionId, machineId }))?.kind;
}

/** The body subject is distinct from the Machine that captured execution custody. */
export function readApprovalArtifactObservationSubjectV1(parsed: ApprovalObservationRequestV1): Readonly<{
  sessionId: string | null;
  target: ExternalActionTargetV1 | null;
}> {
  const header = parsed.family === 'target_action'
    ? buildTargetActionApprovalArtifactHeaderV1(parsed.request)
    : buildApprovalRequestArtifactHeaderV1(parsed.request);
  const origin = parsed.family === 'target_action' ? parsed.request.executionOriginV1
    : parsed.request.v === 2 ? parsed.request.executionOriginV1 : null;
  return { sessionId: typeof header.sessionId === 'string' ? header.sessionId.trim() || null : null,
    target: origin?.target ?? approvalHeaderTarget(header) };
}

/** Session-to-Machine membership comes only from authenticated current Session authority. */
export async function isApprovalArtifactObservationGrantedV1(
  parsed: ApprovalObservationRequestV1,
  grant?: ApiTokenGrantV1 | null,
  resolveSessionMachineId?: (sessionId: string) => Promise<string | null>,
): Promise<boolean> {
  return isApprovalObservationTargetGranted(readApprovalArtifactObservationSubjectV1(parsed).target, grant, resolveSessionMachineId);
}

/** Header narrowing and exact/body admission use the same current-locality membership owner. */
async function isApprovalObservationTargetGranted(
  target: ExternalActionTargetV1 | null,
  grant?: ApiTokenGrantV1 | null,
  resolveSessionMachineId?: (sessionId: string) => Promise<string | null>,
): Promise<boolean> {
  if (!grant || grant.targets === null) return true;
  if (isApiTokenGrantTargetMemberV1(grant, target)) return true;
  if (target?.kind !== 'session' || grant.targets.machines.length === 0 || !resolveSessionMachineId) return false;
  try { return isApiTokenGrantTargetMemberV1(grant, target, await resolveSessionMachineId(target.sessionId)); }
  catch { return false; }
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
    && (header.approvalTargetKind === undefined
      || header.approvalTargetKind === approvalObservationTargetKind(origin?.target, sessionId, machineId))
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

type ApprovalListArtifactV1 = Readonly<{
  artifactId: string;
  header: ApprovalArtifactHeaderCandidateV1;
  body?: unknown;
  updatedAt: number;
}>;

/** Correlation comes from admitted publication custody or the exact Run caller, never a Session/header hint. */
export function readOpenWorkflowPublicationApprovalTargetV1(
  parsed: ParsedApprovalArtifactBodyV1 | null,
): Readonly<{ serverId: string; runId: string }> | null {
  if (!parsed || parsed.family === 'execution_run_host_action' || parsed.request.status !== 'open'
    || parsed.family === 'built_in' && parsed.request.v !== 2) return null;
  const origin = parsed.family === 'target_action' ? parsed.request.executionOriginV1
    : parsed.request.v === 2 ? parsed.request.executionOriginV1 : undefined;
  if (!origin) return null;
  const returned = parsed.family === 'built_in' && parsed.request.actionId === 'discussion.reply'
    ? origin.discussionReplyReturn : undefined;
  const runId = returned && ('kind' in returned ? returned.producer.runId : returned.workflow?.runId);
  const callerRunId = origin.caller.kind === 'workflowRun' ? origin.caller.runId : null;
  const targetRunId = runId ?? callerRunId;
  return targetRunId ? { serverId: origin.serverIdentityId ?? origin.serverId, runId: targetRunId } : null;
}

/** One strict private queue projection for keyholding Account Artifact stores. */
export async function listApprovalArtifactsV1(params: Readonly<{
  status?: ApprovalRequest['status'] | null;
  actionId?: ActionId | null;
  cursor?: string | null;
  limit?: number | null;
  serverId?: string | null;
  sessionId?: string | null;
  /** Host-admitted credential scope, checked before hydration and against the authoritative body. */
  targetGrant?: ApiTokenGrantV1 | null;
  resolveSessionMachineId?: (sessionId: string) => Promise<string | null>;
  /** Open publication or caller-originated requests for one exact Workflow Run. */
  workflowRunId?: string | null;
  subjectKey?: string | null;
  readPage: (options: ArtifactListSelectionOptionsV1 & Readonly<{ limit: number; includeBody: true }>) => Promise<Readonly<{
    items: readonly ApprovalListArtifactV1[];
    nextCursor?: string;
  }>>;
  read: (artifactId: string) => Promise<Readonly<{ header: ApprovalArtifactHeaderCandidateV1; body?: unknown; updatedAt: number }> | null>;
}>): Promise<ApprovalQueueListResultV1> {
  const items: ApprovalQueueListItemV1[] = [];
  const serverId = params.serverId?.trim() || null;
  const sessionId = params.sessionId?.trim() || null;
  const workflowRunId = params.workflowRunId?.trim() || null;
  const sessionMachines = new Map<string, Promise<string | null>>();
  const readSessionMachineId = params.resolveSessionMachineId;
  const resolveSessionMachineId = readSessionMachineId ? (sessionId: string) => {
    let pending = sessionMachines.get(sessionId);
    if (!pending) {
      pending = readSessionMachineId(sessionId);
      sessionMachines.set(sessionId, pending);
    }
    return pending;
  } : undefined;
  const status = params.status ?? (workflowRunId ? 'open' : null);
  // Preserve the approval.request.list input contract and incumbent default.
  const maxItems = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(100, Math.trunc(params.limit))) : 32;
  let cursor = params.cursor ?? undefined;
  do {
    // A source page must fit the remaining result capacity. Advancing its
    // cursor after consuming only a prefix would silently skip valid matches.
    const page = await params.readPage({ limit: maxItems - items.length, includeBody: true,
      kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn, APPROVAL_ARTIFACT_KINDS_V1.targetAction],
      ...(status ? { approvalStates: [status] } : {}),
      ...(sessionId ? { approvalSessionIds: [sessionId] } : {}),
      ...(params.subjectKey ? { indexedKinds: [managedDeleteApprovalIndexedKindV1(params.subjectKey)] } : {}),
      ...(params.targetGrant?.targets ? { headerAdmission: async (header: ApprovalArtifactHeaderCandidateV1) => {
        const target = approvalHeaderTarget(header);
        const candidates = [target];
        // Older headers cannot distinguish an explicit Machine subject from
        // its requesting Session. Exclude only if neither possible subject is
        // granted; strict body admission below resolves that ambiguity.
        if (header.approvalTargetKind === undefined && target?.kind === 'session'
          && typeof header.machineId === 'string' && header.machineId) {
          candidates.push({ kind: 'machine', machineId: header.machineId });
        }
        for (const candidate of candidates) {
          if (await isApprovalObservationTargetGranted(candidate, params.targetGrant, resolveSessionMachineId)) return true;
        }
        return false;
      } } : {}),
      headerFilter: header => {
        if (header.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn && header.kind !== APPROVAL_ARTIFACT_KINDS_V1.targetAction) return false;
        // Approval status can change between the header page and hydration.
        // Keep that filter at the fresh, body-authoritative read below.
        return (!params.actionId || (header.kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction ? 'action.invoke' : header.actionId) === params.actionId)
          && (!sessionId || header.sessionId === sessionId)
          && (!params.subjectKey || header.approvalSubjectKey === params.subjectKey);
      }, ...(cursor ? { cursor } : {}) });
    for (const artifact of page.items) {
      if (items.length >= maxItems) break;
      if (artifact.header.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn
        && artifact.header.kind !== APPROVAL_ARTIFACT_KINDS_V1.targetAction) continue;
      // Complete pages already pair header/body revisions. Only omitted or
      // unreadable bodies need the store's canonical individual read path.
      const hydrated = typeof artifact.body === 'string' ? artifact : await params.read(artifact.artifactId);
      if (typeof hydrated?.body !== 'string') continue;
      const parsed = approvalArtifactBodyMatchesHeaderV1(hydrated.header, hydrated.body);
      if (!parsed || parsed.family === 'execution_run_host_action') continue;
      const request = parsed.request;
      if (status && request.status !== status) continue;
      if (workflowRunId) {
        const target = readOpenWorkflowPublicationApprovalTargetV1(parsed);
        const origin = parsed.family === 'target_action' ? parsed.request.executionOriginV1
          : parsed.request.v === 2 ? parsed.request.executionOriginV1 : undefined;
        if (target?.runId !== workflowRunId || serverId && target.serverId !== serverId
          && origin?.serverId !== serverId) continue;
      }
      if (sessionId && readApprovalArtifactObservationSubjectV1(parsed).sessionId !== sessionId) continue;
      const headerServerId = typeof hydrated.header.serverId === 'string' ? hydrated.header.serverId.trim() || null : null;
      // V1 history retains its released profile-scoped behavior. V2 custody is
      // Account-scoped; its strict body validates the creator profile and Home.
      if (parsed.family === 'built_in' && request.v === 1 && serverId && headerServerId !== serverId) continue;
      const actionId = ActionIdSchema.safeParse(parsed.family === 'target_action' ? 'action.invoke' : parsed.request.actionId);
      if (!actionId.success || !request.summary) continue;
      if (params.actionId && actionId.data !== params.actionId) continue;
      if (!await isApprovalArtifactObservationGrantedV1(parsed, params.targetGrant, resolveSessionMachineId)) continue;
      const itemSessionId = typeof hydrated.header.sessionId === 'string' ? hydrated.header.sessionId.trim() : '';
      items.push({ artifactId: artifact.artifactId, status: request.status, actionId: actionId.data, summary: request.summary,
        ...(itemSessionId ? { sessionId: itemSessionId } : {}), ...(headerServerId ? { serverId: headerServerId } : {}),
        updatedAtMs: Number.isFinite(hydrated.updatedAt) ? hydrated.updatedAt : 0 });
    }
    cursor = page.nextCursor;
  } while (cursor && items.length < maxItems);
  return { items, nextCursor: cursor ?? null, queryPlan: { kind: params.subjectKey
    ? 'bounded_approval_artifact_header_scan' : 'approval_artifact_header_scan', backingStore: 'ArtifactStore',
    boundedBy: params.subjectKey ? 'exact approval subject key'
      : items.length >= maxItems ? 'requested matching approval count' : 'ArtifactStore source exhaustion',
    serverLimit: maxItems, hydratedTranscripts: false } };
}
