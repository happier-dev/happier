import { ArtifactAccessGrantsListResponseV1Schema, type ArtifactAccessGrantsListResponseV1 } from '../../artifacts/artifactAccessV1.js';
import { isStoredContentPublicShareActiveV1, StoredContentPublicSharesListResponseV1Schema, type StoredContentPublicSharesListResponseV1 } from '../../sharing/storedContentPublicShareV1.js';
import { readSessionMemoryEnabledV1, SessionPromptStackV1Schema } from '../../sessions/context/sessionContextV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { type MemoryFactV1 } from '../../prompts/library/memoryDocV1.js';
import type { PromptDocArtifactRefV1 } from '../../prompts/library/promptArtifactRefsV1.js';
import type { PromptStackEntryV1 } from '../../prompts/library/promptStacksV1.js';
import { readSessionBotV1 } from '../../sessions/identity/sessionBotV1.js';
import { MemoryRememberInputV1Schema, MemoryUpdateInputV1Schema, MemoryForgetInputV1Schema } from '../../prompts/library/memoryActionsV1.js';
import { readMemoryDocInLibrary, readReviewedMemoryDocInLibrary, createMemoryDocInLibrary, rememberMemoryFactInLibrary, updateMemoryFactInLibrary, forgetMemoryFactInLibrary,
  type PromptLibraryArtifactStore, type MemoryDocMutationTargetV1 } from '../../prompts/library/promptLibraryActionOperations.js';
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
/** Real host boundaries only: Artifact storage/exposure and the exact Session owner view. */
export type MemoryLibraryActionPortV1 = Readonly<{
  serverId: string; store: PromptLibraryArtifactStore; randomId: () => string; nowMs?: () => number;
  /** Hosts with Home aliases supply their canonical identity comparison. */
  isSameServerId?: (serverId: string) => boolean;
  readExposure: (artifactId: string, context: ActionExecutorContext) => Promise<Readonly<{
    grants: ArtifactAccessGrantsListResponseV1; publicShares: StoredContentPublicSharesListResponseV1 | null;
  }>>;
  readSession?: (ref: Readonly<{ serverId: string; sessionId: string }>, context: ActionExecutorContext) => Promise<MemorySessionSnapshotV1>;
  readInheritedContext?: (snapshot: MemorySessionSnapshotV1, context: ActionExecutorContext) => Promise<MemoryInheritedContextV1>;
  /** One qualified reader per layer; results retain the requested reference order. */
  readArtifactHeaders?: (refs: readonly PromptDocArtifactRefV1[], context: ActionExecutorContext) => Promise<readonly (Readonly<Record<string, unknown>> | null)[]>;
}>;
export type MemoryWriteAdmissionV1 = Readonly<{
  safety: 'safe' | 'danger'; target: MemoryDocMutationTargetV1 | null;
  createScope?: 'bot' | 'account'; attachAccountMemory?: MemoryAccountContextV1['attachAccountMemory'];
}>;
/** Persist the resolved document/revision (or its absence) in the existing approval custody. */
export function bindMemoryWriteApprovalInputV1(actionId: string, input: unknown, admission: MemoryWriteAdmissionV1): unknown {
  if (actionId !== 'memory.remember') return input;
  const request = MemoryRememberInputV1Schema.parse(input);
  return 'sessionRef' in request ? { ...request, reviewedTarget: admission.target } : request;
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
  // The caller itself is already a non-owner grantee; no public roster is needed to prove sharing.
  if (grants.data.access !== 'owner' || grants.data.grants.some(grant => grant.principal.kind !== 'account'
    || grant.principal.accountId !== grants.data.ownerAccountId)) return 'danger';
  const publication = StoredContentPublicSharesListResponseV1Schema.safeParse(exposure.publicShares);
  if (!publication.success || publication.data.publicShares.some(row => row.subject.kind !== 'artifact' || row.subject.id !== artifactId)) {
    refuse('memory_exposure_unavailable');
  }
  const nowMs = (port.nowMs ?? Date.now)();
  return publication.data.publicShares.some(row => isStoredContentPublicShareActiveV1(row, nowMs)) ? 'danger' : 'safe';
}

export async function readMemoryWriteAdmissionV1(port: MemoryLibraryActionPortV1, actionId: string, input: unknown, context: ActionExecutorContext): Promise<MemoryWriteAdmissionV1> {
  assertMemoryHomeV1(port, context.serverId);
  const request = actionId === 'memory.remember' ? MemoryRememberInputV1Schema.parse(input)
    : actionId === 'memory.update' ? MemoryUpdateInputV1Schema.parse(input) : MemoryForgetInputV1Schema.parse(input);
  let target: MemoryDocMutationTargetV1;
  if ('sessionRef' in request) {
    assertMemoryHomeV1(port, request.sessionRef.serverId);
    if (!port.readSession) refuse('session_target_unavailable');
    const snapshot = await port.readSession(request.sessionRef, context);
    if (snapshot.revision !== request.expectedMetadataRevision) refuse('version_mismatch');
    if (!readSessionMemoryEnabledV1(snapshot.metadata)) refuse('action_disabled');
    // A durable replay cannot silently resolve a new target/revision from an old Session-only request.
    if (context.bypassApprovals === true && request.reviewedTarget === undefined) refuse('approval_stale');
    const work = snapshot.metadata.work;
    const bot = readSessionBotV1(snapshot.metadata.bot ?? (work && typeof work === 'object' && 'bot' in work ? work.bot : undefined));
    let attached: PromptStackEntryV1 | undefined;
    if (bot) {
      const stack = createStoredReadSchema(SessionPromptStackV1Schema).parse(work && typeof work === 'object' && 'promptStack' in work ? work.promptStack : []);
      attached = stack.find(entry => entry.id === 'session.memory');
      if (!attached) {
        if (request.reviewedTarget != null) refuse('approval_stale');
        return { safety: 'safe', target: null, createScope: 'bot' };
      }
    } else {
      if (!port.readInheritedContext || !port.readArtifactHeaders) refuse('memory_target_unavailable');
      const readHeaders = port.readArtifactHeaders;
      const inherited = await port.readInheritedContext(snapshot, context);
      const findMemory = async (entries: readonly PromptStackEntryV1[]) => {
        const docs = entries.filter(entry => entry.ref.kind === 'doc');
        if (!docs.length) return undefined;
        context.signal?.throwIfAborted();
        const headers = await readHeaders(docs.map(entry => ({ ...entry.ref, kind: 'doc' as const })), context);
        if (headers.length !== docs.length) refuse('memory_target_unavailable');
        for (let index = 0; index < docs.length; index++) {
          if (headers[index]?.kind === 'memory_doc.v1') return docs[index];
        }
        return undefined;
      };
      attached = await findMemory(inherited.projectEntries);
      if (!attached) {
        const account = await inherited.readAccountContext();
        attached = await findMemory(account.accountEntries);
        if (!attached) {
          if (request.reviewedTarget != null) refuse('approval_stale');
          return { safety: 'safe', target: null, createScope: 'account', attachAccountMemory: account.attachAccountMemory };
        }
      }
    }
    if (attached.ref.kind !== 'doc') refuse('memory_doc_invalid');
    assertMemoryHomeV1(port, attached.ref.serverId);
    if (request.reviewedTarget !== undefined) {
      if (request.reviewedTarget === null || request.reviewedTarget.ref.artifactId !== attached.ref.artifactId) refuse('approval_stale');
      assertMemoryHomeV1(port, request.reviewedTarget.ref.serverId);
      target = request.reviewedTarget;
    } else {
      const read = await readMemoryDocInLibrary({ store: port.store, artifactId: attached.ref.artifactId, signal: context.signal });
      target = { ref: { ...attached.ref, kind: 'doc' }, expectedRevision: read.revision };
    }
  } else {
    assertMemoryHomeV1(port, request.ref.serverId);
    target = request;
  }
  await readReviewedMemoryDocInLibrary({ store: port.store, request: target, signal: context.signal });
  return { target, safety: await readSafety(port, target.ref.artifactId, context) };
}

export async function executeMemoryWriteV1(args: Readonly<{
  port: MemoryLibraryActionPortV1; actionId: string; input: unknown; context: ActionExecutorContext;
  admission: MemoryWriteAdmissionV1; sessionStateFieldSet?: ActionExecutorDeps['sessionStateFieldSet'];
}>) {
  const { port, context, admission } = args;
  const sourceSessionRef: MemoryFactV1['sourceSessionRef'] = context.defaultSessionId
    ? { serverId: port.serverId, sessionId: context.defaultSessionId } : null;
  const author = { randomId: port.randomId, nowMs: port.nowMs, sourceSessionRef };
  // Check again immediately before the existing store's full-revision CAS.
  const store: PromptLibraryArtifactStore = { ...port.store, update: async input => {
    const currentSafety = await readSafety(port, input.artifactId, context);
    if (admission.safety === 'safe' && currentSafety === 'danger') refuse('approval_stale');
    input.signal?.throwIfAborted();
    await port.store.update(input);
  } };
  if (args.actionId === 'memory.remember') {
    const request = MemoryRememberInputV1Schema.parse(args.input);
    if ('sessionRef' in request && admission.target === null) {
      if (!port.store.create || (admission.createScope === 'bot' ? !args.sessionStateFieldSet : !admission.attachAccountMemory)) refuse('memory_target_unavailable');
      // Re-read the Session and selected scope before creating anything; their incumbent writers own attachment CAS.
      const current = await readMemoryWriteAdmissionV1(port, args.actionId, request, context);
      if (current.target !== null || current.createScope !== admission.createScope) refuse('version_mismatch');
      const { artifactId, factId } = await createMemoryDocInLibrary({ store: port.store, request: {
        title: current.createScope === 'bot' ? 'Bot memory' : 'Account memory', text: request.text,
        ...(request.topic === undefined ? {} : { topic: request.topic }),
        ...(request.expiresAtMs === undefined ? {} : { expiresAtMs: request.expiresAtMs }),
      }, ...author, signal: context.signal });
      const ref = { kind: 'doc' as const, artifactId, serverId: request.sessionRef.serverId };
      let attachment: 'attached' | 'conflict' = 'conflict';
      try {
        if (current.createScope === 'account') {
          if (await current.attachAccountMemory!(ref)) attachment = 'attached';
        } else {
          const result = await args.sessionStateFieldSet!({ actionId: 'session.context.update', context,
            sessionId: request.sessionRef.sessionId, serverId: request.sessionRef.serverId, fieldId: 'intent.context',
            expectedMetadataRevision: request.expectedMetadataRevision,
            value: { kind: 'attach', entry: { id: 'session.memory', ref, enabled: true, placement: 'system_append' } } });
          if (result && typeof result === 'object' && 'ok' in result && result.ok === true) attachment = 'attached';
        }
      } catch { /* The durable fact survives attach refusal; the caller receives its exact ref for retry. */ }
      return { ok: true as const, artifactId, factId, ref, attachment };
    }
    if (!admission.target) refuse('memory_doc_invalid');
    return rememberMemoryFactInLibrary({ store, request: { ...admission.target, text: request.text,
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      ...(request.expiresAtMs === undefined ? {} : { expiresAtMs: request.expiresAtMs }) }, ...author, signal: context.signal });
  }
  if (args.actionId === 'memory.update') return updateMemoryFactInLibrary({ store,
    request: MemoryUpdateInputV1Schema.parse(args.input), ...author, signal: context.signal });
  return forgetMemoryFactInLibrary({ store, request: MemoryForgetInputV1Schema.parse(args.input), signal: context.signal });
}
