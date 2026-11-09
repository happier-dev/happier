import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { MEMORY_ARCHIVE_TOPIC_TITLE_V1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { selectMemoryTargetV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { MemoryMutationResultV1Schema, MemoryDuplicateChoiceRequiredV1Schema,
  type MemoryDuplicateChoiceV1, type MemoryAttachmentFailureV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';

export type MemoryCreationReceipt = Readonly<{
  ref: PromptDocArtifactRefV1;
  attachment: 'attached' | 'conflict';
  attachmentFailure?: MemoryAttachmentFailureV1;
  /** Exact persisted fact; recovery opens this fact rather than submitting the draft again. */
  factId?: string;
}>;

/** Creation saves the fact before attachment CAS; retain its exact document even on conflict. */
export function readMemoryCreationReceipt(result: ActionExecuteResult): MemoryCreationReceipt | null {
  if (!result.ok) return null;
  const parsed = MemoryMutationResultV1Schema.safeParse(result.result);
  return parsed.success && parsed.data.ref && parsed.data.attachment
    ? { ref: parsed.data.ref, attachment: parsed.data.attachment, factId: parsed.data.factId,
      ...(parsed.data.attachmentFailure ? { attachmentFailure: parsed.data.attachmentFailure } : {}) }
    : null;
}

export type MemoryDocumentRevision = Readonly<{
  headerVersion: number;
  bodyVersion: number;
}>;

/** One reviewed memory document (and optionally one of its topics) on one Home. */
export type MemoryDocumentTarget = Readonly<{
  ref: PromptDocArtifactRefV1;
  serverId: string;
  /** The Account that admitted this reviewed document; a replacement cannot inherit its intent. */
  accountId: string;
  isCurrent: () => boolean;
  expectedRevision: MemoryDocumentRevision;
  topic?: string;
}>;

/** A Session whose own default memory target the host resolves (Bot, Project, else Account memory). */
export type MemorySessionTarget = Readonly<{
  sessionId: string;
  serverId: string;
  expectedMetadataRevision: number;
}>;

export type MemoryActionOutcome =
  | 'applied'
  | 'review'
  | 'pending'
  | 'conflict'
  | 'saved_unattached'
  | 'refused';

/** An Action receipt as the memory surfaces report it; a conflict means "the document moved". */
export function readMemoryActionOutcome(
  result: ActionExecuteResult,
): MemoryActionOutcome {
  if (!result.ok)
    return result.errorCode === 'conflict' || result.errorCode === 'version_mismatch' ? 'conflict' : 'refused';
  if (readMemoryDuplicateReview(result)) return 'review';
  if (result.result && typeof result.result === 'object' && 'ok' in result.result && result.result.ok === false) return 'refused';
  if (readMemoryCreationReceipt(result)?.attachment === 'conflict') return 'saved_unattached';
  return ActionApprovalRequestCreatedResultSchema.safeParse(result.result)
    .success
    ? 'pending'
    : 'applied';
}

/** Typed candidate data for the same save sheet; a review never acknowledges a persisted fact. */
export function readMemoryDuplicateReview(result: ActionExecuteResult) {
  if (!result.ok) return null;
  const review = MemoryDuplicateChoiceRequiredV1Schema.safeParse(result.result);
  return review.success ? review.data : null;
}

async function execute(
  actionId:
    | 'memory.remember'
    | 'memory.decision.save'
    | 'memory.update'
    | 'memory.forget'
    | 'session.memory.set'
    | 'session.context.update',
  input: Readonly<Record<string, unknown>>,
  serverId: string,
  signal?: AbortSignal,
  expectedAccountId?: string,
): Promise<ActionExecuteResult> {
  const { createDefaultActionExecutor } =
    await import('@/sync/ops/actions/defaultActionExecutor');
  return createDefaultActionExecutor().execute(actionId, input, {
    serverId,
    surface: 'ui',
    authority: 'present_user',
    ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
    ...(signal ? { signal } : {}),
  });
}

function documentInput(target: MemoryDocumentTarget) {
  return {
    ref: { ...target.ref, serverId: target.ref.serverId ?? target.serverId },
    expectedRevision: target.expectedRevision,
    ...(target.topic === undefined ? {} : { topic: target.topic }),
  };
}

export type MemoryFactDraft = Readonly<{ text: string; expiresAtMs?: number; duplicateChoice?: MemoryDuplicateChoiceV1 }>;
export type MemoryScopedFactDraft = MemoryFactDraft & Readonly<{
  topic?: string;
  /** Preserve the reviewed document when replaying a choice through its original Session or scope. */
  reviewedTarget?: Readonly<{ ref: PromptDocArtifactRefV1; expectedRevision: MemoryDocumentRevision }>;
}>;

/** Message menus and C1's answered lasting questions seed the same reviewed save input. */
export type MemoryDecisionDraft = MemoryFactDraft & Readonly<{
  reason: string;
  sourceMessageRef: CoordinationMessageRefV1;
}>;
export type MemoryScopedDecisionDraft = MemoryScopedFactDraft & MemoryDecisionDraft;

export type MemoryDecisionTarget = Readonly<{
  target: MemoryScopeTargetV1;
  ref: PromptDocArtifactRefV1 | null;
  /** Project naming stays at the existing workspace label owner; Account copy belongs to the sheet. */
  workspaceRef: WorkspaceRefV1 | null;
  label: string | null;
}>;

/** Finite chooser read through the existing Project catalog, scope admission and batched Artifact headers. */
export async function readMemoryDecisionTargets(serverId: string, signal?: AbortSignal) {
  const [{ captureLazyActionAccountContext }, { readUiMemoryDecisionTargetContexts }, { withUiPromptLibraryArtifactReader }] = await Promise.all([
    import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/readUiMemoryInheritedContext'), import('./promptLibraryArtifactStore'),
  ]);
  const account = await captureLazyActionAccountContext(serverId, signal);
  try {
    const context = { serverId: account.serverId, surface: 'ui' as const, authority: 'present_user' as const, signal };
    const scopes = await readUiMemoryDecisionTargetContexts(account, context);
    let coverage = scopes.coverage;
    const projected = await withUiPromptLibraryArtifactReader(async reader => Promise.all(scopes.targets.map(async row => {
      const docs = row.context.entries.filter(entry => entry.ref.kind === 'doc');
      const headers = await Promise.all(docs.map(entry => reader.readArtifactHeader(entry.ref).catch(() => {
        account.assertCurrent(); signal?.throwIfAborted(); return null;
      })));
      const index = headers.findIndex(header => header?.header?.kind === 'memory_doc.v1');
      if (index < 0 && headers.some(header => !header?.header)) { coverage = 'partial'; return null; }
      if (index >= 0 && (headers[index]?.access === 'view' || !headers[index]?.access)) return null;
      const ref: PromptDocArtifactRefV1 | null = index < 0 ? null : { kind: 'doc', artifactId: docs[index]!.ref.artifactId,
        serverId: docs[index]!.ref.serverId ?? account.serverId };
      const selection = selectMemoryTargetV1({ isBot: false, botRef: null,
        project: { status: 'ready', ref: row.target.scope === 'project' ? ref : null },
        account: { status: 'ready', ref: row.target.scope === 'account' ? ref : null } });
      return { target: row.target, ref: selection.ref, workspaceRef: row.workspaceRef, label: row.label } satisfies MemoryDecisionTarget;
    })), { serverId: account.serverId, signal, accountContext: account });
    account.assertCurrent(); signal?.throwIfAborted();
    return { targets: projected.filter((row): row is MemoryDecisionTarget => row !== null),
      coverage };
  } finally { account.dispose(); }
}

/**
 * The memory surfaces' only writers: the public `memory.*` and Session context Actions. Work, the
 * Context pages and the topic page never write an Artifact body or Session metadata themselves.
 */
export const memoryDocumentActions = {
  saveDecisionInScope: (
    target: MemoryScopeTargetV1,
    draft: MemoryScopedDecisionDraft,
    serverId: string,
    signal?: AbortSignal,
  ) => execute('memory.decision.save', { ...target, ...draft }, target.scope === 'project' ? target.projectRef.serverId : serverId, signal),
  saveDecision: (
    target: MemoryDocumentTarget,
    draft: MemoryDecisionDraft,
    signal?: AbortSignal,
  ) => execute('memory.decision.save', { ...documentInput(target), ...draft }, target.serverId, signal, target.accountId),
  saveDecisionInSession: (
    target: MemorySessionTarget,
    draft: MemoryScopedDecisionDraft,
    signal?: AbortSignal,
  ) => execute('memory.decision.save', {
    sessionRef: { serverId: target.serverId, sessionId: target.sessionId },
    expectedMetadataRevision: target.expectedMetadataRevision,
    ...draft,
  }, target.serverId, signal),
  /** Account and Project Context use the same lazy memory Action without a Session. */
  rememberInScope: (
    target: MemoryScopeTargetV1,
    draft: MemoryScopedFactDraft,
    serverId: string,
    signal?: AbortSignal,
  ) => execute('memory.remember', { ...target, ...draft }, target.scope === 'project' ? target.projectRef.serverId : serverId, signal),
  remember: (
    target: MemoryDocumentTarget,
    draft: MemoryFactDraft,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.remember',
      { ...documentInput(target), ...draft },
      target.serverId,
      signal,
      target.accountId,
    ),
  /** No document is attached yet: the host picks (and lazily creates) the Session's own target. */
  rememberInSession: (
    target: MemorySessionTarget,
    draft: MemoryScopedFactDraft,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.remember',
      {
        sessionRef: { serverId: target.serverId, sessionId: target.sessionId },
        expectedMetadataRevision: target.expectedMetadataRevision,
        ...draft,
      },
      target.serverId,
      signal,
    ),
  update: (
    target: MemoryDocumentTarget,
    input: Readonly<{ factId: string; text: string; expiresAtMs?: number | null; duplicateChoice?: MemoryDuplicateChoiceV1 }>,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.update',
      { ...documentInput(target), ...input },
      target.serverId,
      signal,
      target.accountId,
    ),
  restore: (
    target: MemoryDocumentTarget,
    factId: string,
    restoreTopic?: string,
    signal?: AbortSignal,
    duplicateChoice?: MemoryDuplicateChoiceV1,
  ) =>
    execute(
      'memory.update',
      {
        ...documentInput(target),
        topic: MEMORY_ARCHIVE_TOPIC_TITLE_V1,
        factId,
        restore: true,
        ...(restoreTopic === undefined ? {} : { restoreTopic }),
        ...(duplicateChoice === undefined ? {} : { duplicateChoice }),
      },
      target.serverId,
      signal,
      target.accountId,
    ),
  forget: (
    target: MemoryDocumentTarget,
    factId: string,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.forget',
      { ...documentInput(target), factId },
      target.serverId,
      signal,
      target.accountId,
    ),
  setSessionMemory: (
    target: MemorySessionTarget,
    enabled: boolean,
    signal?: AbortSignal,
  ) =>
    execute(
      'session.memory.set',
      { ...target, enabled },
      target.serverId,
      signal,
    ),
  updateSessionContext: (
    target: MemorySessionTarget,
    intent: SessionContextIntentV1,
    signal?: AbortSignal,
  ) =>
    execute(
      'session.context.update',
      { ...target, intent },
      target.serverId,
      signal,
    ),
};
