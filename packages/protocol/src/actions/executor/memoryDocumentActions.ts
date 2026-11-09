import { ArtifactAccessGrantsListResponseV1Schema, type ArtifactAccessGrantsListResponseV1 } from '../../artifacts/artifactAccessV1.js';
import { readArtifactSharedAudienceV1 } from '../../artifacts/artifactSharingV1.js';
import { isStoredContentPublicShareActiveV1, StoredContentPublicSharesListResponseV1Schema, type StoredContentPublicSharesListResponseV1 } from '../../sharing/storedContentPublicShareV1.js';
import { readSessionMemoryEnabledV1, SessionPromptStackV1Schema } from '../../sessions/context/sessionContextV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { selectMemoryTargetV1, type MemoryFactV1 } from '../../prompts/library/memoryDocV1.js';
import { reviewMemoryFactWriteV1 } from '../../prompts/library/memoryFactCandidatesV1.js';
import type { PromptDocArtifactRefV1 } from '../../prompts/library/promptArtifactRefsV1.js';
import type { PromptStackEntryV1 } from '../../prompts/library/promptStacksV1.js';
import { readSessionBotV1 } from '../../sessions/identity/sessionBotV1.js';
import { MemoryRememberInputV1Schema, MemoryDecisionSaveInputV1Schema, MemoryUpdateInputV1Schema, MemoryForgetInputV1Schema, type MemoryScopeTargetV1,
  type MemoryDuplicateChoiceRequiredV1, MemoryAttachmentFailureV1Schema, type MemoryAttachmentFailureV1 } from '../../prompts/library/memoryActionsV1.js';
import { readMemoryDocVersionInLibrary, readReviewedMemoryDocInLibrary, readRestorableMemoryFactV1, createMemoryDocInLibrary, rememberMemoryFactInLibrary, updateMemoryFactInLibrary, forgetMemoryFactInLibrary,
  type PromptLibraryArtifactStore, type MemoryDocMutationTargetV1, type MemoryDocMutationReadV1 } from '../../prompts/library/promptLibraryActionOperations.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

export type MemorySessionSnapshotV1 = Readonly<{
  metadata: Readonly<Record<string, unknown>>; revision: number; machineId?: string;
}>;
export type MemoryAccountContextV1 = Readonly<{
  accountEntries: readonly PromptStackEntryV1[];
  /** Captured coding-row CAS at the existing Account context writer. */
  attachAccountMemory: (ref: PromptDocArtifactRefV1) => Promise<boolean>;
}>;
export type MemoryInheritedContextV1 = Readonly<{
  projectEntries: readonly PromptStackEntryV1[];
  readAccountContext: () => Promise<MemoryAccountContextV1>;
}>;
export type MemoryScopeContextV1 = Readonly<{
  entries: readonly PromptStackEntryV1[];
  attachMemory: (ref: PromptDocArtifactRefV1) => Promise<boolean>;
  safety: 'safe' | 'danger';
}>;
/** Real host boundaries only: Artifact storage/exposure and the exact Session owner view. */
export type MemoryLibraryActionPortV1 = Readonly<{
  serverId: string; store: PromptLibraryArtifactStore; randomId: () => string; nowMs?: () => number;
  /** The host selects its existing Artifact transport for this invoking Account. */
  storeForContext?: (context: ActionExecutorContext) => PromptLibraryArtifactStore;
  /** Hosts with Home aliases supply their canonical identity comparison. */
  isSameServerId?: (serverId: string) => boolean;
  readExposure: (artifactId: string, context: ActionExecutorContext) => Promise<Readonly<{
    grants: ArtifactAccessGrantsListResponseV1; publicShares: StoredContentPublicSharesListResponseV1 | null;
  }>>;
  readSession?: (ref: Readonly<{ serverId: string; sessionId: string }>, context: ActionExecutorContext) => Promise<MemorySessionSnapshotV1>;
  readInheritedContext?: (snapshot: MemorySessionSnapshotV1, context: ActionExecutorContext) => Promise<MemoryInheritedContextV1>;
  readScopeContext?: (target: MemoryScopeTargetV1, context: ActionExecutorContext) => Promise<MemoryScopeContextV1>;
  /** One qualified reader per layer; results retain the requested reference order. */
  readArtifactHeaders?: (refs: readonly PromptDocArtifactRefV1[], context: ActionExecutorContext) => Promise<readonly (Readonly<Record<string, unknown>> | null)[]>;
}>;
export type MemoryWriteAdmissionV1 = Readonly<{
  safety: 'safe' | 'danger'; target: MemoryDocMutationTargetV1 | null;
  read?: MemoryDocMutationReadV1;
  createScope?: 'bot' | 'account' | 'project'; attachAccountMemory?: MemoryAccountContextV1['attachAccountMemory'];
  attachMemory?: MemoryScopeContextV1['attachMemory'];
  duplicateReview?: MemoryDuplicateChoiceRequiredV1;
}>;
/** Persist the resolved document/revision (or its absence) in the existing approval custody. */
export function bindMemoryWriteApprovalInputV1(actionId: string, input: unknown, admission: MemoryWriteAdmissionV1): unknown {
  if (actionId !== 'memory.remember' && actionId !== 'memory.decision.save') return input;
  const request = (actionId === 'memory.decision.save' ? MemoryDecisionSaveInputV1Schema : MemoryRememberInputV1Schema).parse(input);
  return 'ref' in request ? request : { ...request, reviewedTarget: admission.target };
}
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
export function assertMemoryHomeV1(port: MemoryLibraryActionPortV1, serverId?: string | null): void {
  if (serverId != null && !(port.isSameServerId ? port.isSameServerId(serverId) : serverId === port.serverId)) refuse('server_target_mismatch');
}
async function readSafety(port: MemoryLibraryActionPortV1, artifactId: string, context: ActionExecutorContext): Promise<'safe' | 'danger'> {
  context.signal?.throwIfAborted();
  const exposure = await port.readExposure(artifactId, context);
  const grants = ArtifactAccessGrantsListResponseV1Schema.safeParse(exposure.grants);
  if (!grants.success || grants.data.artifactId !== artifactId) refuse('memory_exposure_unavailable');
  const publication = StoredContentPublicSharesListResponseV1Schema.safeParse(exposure.publicShares);
  const nowMs = (port.nowMs ?? Date.now)();
  const publicAudience = !publication.success
    || publication.data.publicShares.some(row => row.subject.kind !== 'artifact' || row.subject.id !== artifactId)
    ? 'unknown' : publication.data.publicShares.some(row => isStoredContentPublicShareActiveV1(row, nowMs)) ? 'retained' : 'none';
  try {
    return await readArtifactSharedAudienceV1({
      current: { artifactId, header: {}, ownerAccountId: grants.data.ownerAccountId, access: grants.data.access, publicAudience },
      readGrants: async () => grants.data, signal: context.signal,
    }) ? 'danger' : 'safe';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'content_unavailable') refuse('memory_exposure_unavailable');
    throw error;
  }
}
async function findScopeMemory(port: MemoryLibraryActionPortV1, entries: readonly PromptStackEntryV1[], context: ActionExecutorContext) {
  const docs = entries.filter(entry => entry.ref.kind === 'doc');
  if (!docs.length) return undefined;
  if (!port.readArtifactHeaders) refuse('memory_target_unavailable');
  context.signal?.throwIfAborted();
  for (const entry of docs) assertMemoryHomeV1(port, entry.ref.serverId);
  const headers = await port.readArtifactHeaders(docs.map(entry => ({ ...entry.ref, kind: 'doc' as const })), context);
  if (headers.length !== docs.length) refuse('memory_target_unavailable');
  return docs.find((_, index) => headers[index]?.kind === 'memory_doc.v1');
}

export async function readMemoryWriteAdmissionV1(port: MemoryLibraryActionPortV1, actionId: string, input: unknown, context: ActionExecutorContext): Promise<MemoryWriteAdmissionV1> {
  assertMemoryHomeV1(port, context.serverId);
  const store = port.storeForContext?.(context) ?? port.store;
  const decisionRequest = actionId === 'memory.decision.save' ? MemoryDecisionSaveInputV1Schema.parse(input) : null;
  const updateRequest = actionId === 'memory.update' ? MemoryUpdateInputV1Schema.parse(input) : null;
  const request = decisionRequest ?? updateRequest
    ?? (actionId === 'memory.remember' ? MemoryRememberInputV1Schema.parse(input) : MemoryForgetInputV1Schema.parse(input));
  if (decisionRequest) assertMemoryHomeV1(port, decisionRequest.sourceMessageRef.kind === 'session'
    ? decisionRequest.sourceMessageRef.session.serverId : decisionRequest.sourceMessageRef.discussion.serverId);
  if ('duplicateChoice' in request && request.duplicateChoice && !('ref' in request) && request.reviewedTarget == null) refuse('approval_stale');
  let target: MemoryDocMutationTargetV1;
  let currentRead: MemoryDocMutationReadV1 | undefined;
  let scopeSafety: 'safe' | 'danger' = 'safe';
  if ('scope' in request) {
    if (request.scope === 'project') assertMemoryHomeV1(port, request.projectRef.serverId);
    if (!port.readScopeContext) refuse('memory_target_unavailable');
    if (context.bypassApprovals === true && request.reviewedTarget === undefined) refuse('approval_stale');
    const scope = await port.readScopeContext(request, context);
    scopeSafety = scope.safety;
    const attached = await findScopeMemory(port, scope.entries, context);
    if (!attached) {
      if (request.reviewedTarget != null) refuse('approval_stale');
      return { safety: scopeSafety, target: null, createScope: request.scope, attachMemory: scope.attachMemory };
    }
    if (attached.ref.kind !== 'doc') refuse('memory_doc_invalid');
    if (request.reviewedTarget !== undefined) {
      if (request.reviewedTarget === null || request.reviewedTarget.ref.artifactId !== attached.ref.artifactId) refuse('approval_stale');
      assertMemoryHomeV1(port, request.reviewedTarget.ref.serverId);
      target = request.reviewedTarget;
    } else {
      currentRead = await readMemoryDocVersionInLibrary({ store, artifactId: attached.ref.artifactId, signal: context.signal });
      target = { ref: { ...attached.ref, kind: 'doc' }, expectedRevision: currentRead.artifact.revision };
    }
  } else if ('sessionRef' in request) {
    assertMemoryHomeV1(port, request.sessionRef.serverId);
    if (!port.readSession) refuse('session_target_unavailable');
    const snapshot = await port.readSession(request.sessionRef, context);
    // Runtime metadata advances independently of the memory choice and target.
    // Re-read those below; the reviewed document revision remains the write CAS.
    if (!readSessionMemoryEnabledV1(snapshot.metadata)) refuse('action_disabled');
    // A durable replay cannot silently resolve a new target/revision from an old Session-only request.
    if (context.bypassApprovals === true && request.reviewedTarget === undefined) refuse('approval_stale');
    const work = snapshot.metadata.work;
    const bot = readSessionBotV1(snapshot.metadata.bot ?? (work && typeof work === 'object' && 'bot' in work ? work.bot : undefined));
    let selectedRef: PromptDocArtifactRefV1 | null;
    if (bot) {
      const stack = createStoredReadSchema(SessionPromptStackV1Schema).parse(work && typeof work === 'object' && 'promptStack' in work ? work.promptStack : []);
      const attached = stack.find(entry => entry.id === 'session.memory');
      if (attached && attached.ref.kind !== 'doc') refuse('memory_doc_invalid');
      selectedRef = selectMemoryTargetV1({ isBot: true, botRef: attached ? { ...attached.ref, kind: 'doc' } : null }).ref;
      if (!selectedRef) {
        if (request.reviewedTarget != null) refuse('approval_stale');
        return { safety: 'safe', target: null, createScope: 'bot' };
      }
    } else {
      if (!port.readInheritedContext || !port.readArtifactHeaders) refuse('memory_target_unavailable');
      const inherited = await port.readInheritedContext(snapshot, context);
      const projectEntry = await findScopeMemory(port, inherited.projectEntries, context);
      const project = { status: 'ready' as const, ref: projectEntry ? { ...projectEntry.ref, kind: 'doc' as const } : null };
      let selection = selectMemoryTargetV1({ isBot: false, botRef: null, project });
      if (selection.resolving) {
        const account = await inherited.readAccountContext();
        const accountEntry = await findScopeMemory(port, account.accountEntries, context);
        selection = selectMemoryTargetV1({ isBot: false, botRef: null, project,
          account: { status: 'ready', ref: accountEntry ? { ...accountEntry.ref, kind: 'doc' } : null } });
        if (!selection.ref) {
          if (request.reviewedTarget != null) refuse('approval_stale');
          return { safety: 'safe', target: null, createScope: 'account', attachAccountMemory: account.attachAccountMemory };
        }
      }
      selectedRef = selection.ref;
    }
    if (!selectedRef) refuse('memory_doc_invalid');
    assertMemoryHomeV1(port, selectedRef.serverId);
    if (request.reviewedTarget !== undefined) {
      if (request.reviewedTarget === null || request.reviewedTarget.ref.artifactId !== selectedRef.artifactId) refuse('approval_stale');
      assertMemoryHomeV1(port, request.reviewedTarget.ref.serverId);
      target = request.reviewedTarget;
    } else {
      currentRead = await readMemoryDocVersionInLibrary({ store, artifactId: selectedRef.artifactId, signal: context.signal });
      target = { ref: selectedRef, expectedRevision: currentRead.artifact.revision };
    }
  } else {
    assertMemoryHomeV1(port, request.ref.serverId);
    target = request;
  }
  // The revision and candidates of a newly resolved target belong to the same admitted read.
  // Deferred replays acquire their own read; this invocation carries its admitted body to CAS.
  const read = currentRead ?? await readReviewedMemoryDocInLibrary({ store, request: target, signal: context.signal });
  const safety = await readSafety(port, target.ref.artifactId, context);
  const restored = updateRequest && 'restore' in updateRequest ? readRestorableMemoryFactV1(read.body, updateRequest.factId) : undefined;
  const text = 'text' in request ? request.text : restored?.text;
  const duplicateReview = text !== undefined ? reviewMemoryFactWriteV1({ body: read.body, target, text,
    nowMs: (port.nowMs ?? Date.now)(), duplicateChoice: 'duplicateChoice' in request ? request.duplicateChoice : undefined,
    excludeFactId: 'text' in request && 'factId' in request && typeof request.factId === 'string' ? request.factId : undefined }) : null;
  return { target, read, safety: scopeSafety === 'danger' ? 'danger' : safety, ...(duplicateReview ? { duplicateReview } : {}) };
}

export async function executeMemoryWriteV1(args: Readonly<{
  port: MemoryLibraryActionPortV1; actionId: string; input: unknown; context: ActionExecutorContext;
  admission: MemoryWriteAdmissionV1; sessionStateFieldSet?: ActionExecutorDeps['sessionStateFieldSet'];
  approvedBy?: NonNullable<MemoryFactV1['decision']>['approvedBy'];
}>) {
  const { port, context, admission } = args;
  const sourceSessionRef: MemoryFactV1['sourceSessionRef'] = context.defaultSessionId
    ? { serverId: port.serverId, sessionId: context.defaultSessionId } : null;
  const decisionRequest = args.actionId === 'memory.decision.save' ? MemoryDecisionSaveInputV1Schema.parse(args.input) : null;
  if (decisionRequest) {
    const sourceHome = decisionRequest.sourceMessageRef.kind === 'session'
      ? decisionRequest.sourceMessageRef.session.serverId : decisionRequest.sourceMessageRef.discussion.serverId;
    assertMemoryHomeV1(port, sourceHome);
  }
  const author = { randomId: port.randomId, nowMs: port.nowMs, sourceSessionRef, approvedBy: args.approvedBy,
    ...(decisionRequest ? { decision: { reason: decisionRequest.reason, sourceMessageRef: decisionRequest.sourceMessageRef,
      approvedBy: args.approvedBy ?? null } } : {}) };
  const store = port.storeForContext?.(context) ?? port.store;
  if (args.actionId === 'memory.remember' || decisionRequest) {
    const request = decisionRequest ?? MemoryRememberInputV1Schema.parse(args.input);
    if (!('ref' in request) && admission.target === null) {
      if (!store.create || (admission.createScope === 'bot' ? !args.sessionStateFieldSet : !(admission.attachMemory ?? admission.attachAccountMemory))) refuse('memory_target_unavailable');
      const created = await createMemoryDocInLibrary({ store, request: {
        title: admission.createScope === 'bot' ? 'Bot memory' : admission.createScope === 'project' ? 'Project memory' : 'Account memory', text: request.text,
        ...(request.topic === undefined ? {} : { topic: request.topic }),
        ...(request.expiresAtMs === undefined ? {} : { expiresAtMs: request.expiresAtMs }),
      }, ...author, signal: context.signal });
      const { artifactId, factId } = created;
      const ref = { kind: 'doc' as const, artifactId, serverId: port.serverId };
      let attachment: 'attached' | 'conflict' = 'conflict';
      let attachmentFailure: MemoryAttachmentFailureV1 | undefined;
      try {
        if (admission.attachMemory) {
          if (await admission.attachMemory(ref)) attachment = 'attached';
        } else if (admission.createScope === 'account') {
          if (await admission.attachAccountMemory!(ref)) attachment = 'attached';
        } else {
          if (!('sessionRef' in request)) refuse('memory_target_unavailable');
          const result = await args.sessionStateFieldSet!({ actionId: 'session.context.update', context,
            sessionId: request.sessionRef.sessionId, serverId: request.sessionRef.serverId, fieldId: 'intent.context',
            expectedMetadataRevision: request.expectedMetadataRevision,
            value: { kind: 'attach', entry: { id: 'session.memory', ref, enabled: true, placement: 'system_append' } } });
          if (result && typeof result === 'object' && 'ok' in result && result.ok === true) attachment = 'attached';
          else if (result && typeof result === 'object' && 'errorCode' in result) {
            throw Object.assign(new Error('Memory attachment failed'), { code: result.errorCode });
          }
        }
      } catch (error) {
        // The fact is durable. A failed attachment is not evidence that its revision moved.
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'source_conflict' && code !== 'project_context_conflict' && code !== 'entry_conflict'
          && code !== 'version_mismatch' && code !== 'conflict') {
          const failure = MemoryAttachmentFailureV1Schema.safeParse({ errorCode: code });
          attachmentFailure = failure.success ? failure.data : { errorCode: 'memory_target_unavailable' };
        }
      }
      return { ...created, ok: true as const, artifactId, factId, ref, attachment,
        ...(attachmentFailure ? { attachmentFailure } : {}) };
    }
    if (!admission.target) refuse('memory_doc_invalid');
    return rememberMemoryFactInLibrary({ store, admittedRead: admission.read, request: { ...admission.target, text: request.text,
      ...(request.duplicateChoice === undefined ? {} : { duplicateChoice: request.duplicateChoice }),
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      ...(request.expiresAtMs === undefined ? {} : { expiresAtMs: request.expiresAtMs }) }, ...author, signal: context.signal });
  }
  if (args.actionId === 'memory.update') return updateMemoryFactInLibrary({ store, admittedRead: admission.read,
    request: MemoryUpdateInputV1Schema.parse(args.input), ...author, signal: context.signal });
  return forgetMemoryFactInLibrary({ store, admittedRead: admission.read, request: MemoryForgetInputV1Schema.parse(args.input), signal: context.signal });
}
