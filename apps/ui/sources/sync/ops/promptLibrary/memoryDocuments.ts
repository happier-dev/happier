import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { MEMORY_ARCHIVE_TOPIC_TITLE_V1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { SessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';

export type MemoryDocumentRevision = Readonly<{
  headerVersion: number;
  bodyVersion: number;
}>;

/** One reviewed memory document (and optionally one of its topics) on one Home. */
export type MemoryDocumentTarget = Readonly<{
  ref: PromptDocArtifactRefV1;
  serverId: string;
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
  | 'pending'
  | 'conflict'
  | 'refused';

/** An Action receipt as the memory surfaces report it; a conflict means "the document moved". */
export function readMemoryActionOutcome(
  result: ActionExecuteResult,
): MemoryActionOutcome {
  if (!result.ok)
    return result.errorCode === 'version_mismatch' ? 'conflict' : 'refused';
  return ActionApprovalRequestCreatedResultSchema.safeParse(result.result)
    .success
    ? 'pending'
    : 'applied';
}

async function execute(
  actionId:
    | 'memory.remember'
    | 'memory.update'
    | 'memory.forget'
    | 'session.memory.set'
    | 'session.context.update',
  input: Readonly<Record<string, unknown>>,
  serverId: string,
  signal?: AbortSignal,
): Promise<ActionExecuteResult> {
  const { createDefaultActionExecutor } =
    await import('@/sync/ops/actions/defaultActionExecutor');
  return createDefaultActionExecutor().execute(actionId, input, {
    serverId,
    surface: 'ui',
    authority: 'present_user',
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

type FactDraft = Readonly<{ text: string; expiresAtMs?: number }>;

/**
 * The memory surfaces' only writers: the public `memory.*` and Session context Actions. Work, the
 * Context pages and the topic page never write an Artifact body or Session metadata themselves.
 */
export const memoryDocumentActions = {
  /** Account and Project Context use the same lazy memory Action without a Session. */
  rememberInScope: (
    target: MemoryScopeTargetV1,
    draft: FactDraft & Readonly<{ topic?: string }>,
    serverId: string,
    signal?: AbortSignal,
  ) => execute('memory.remember', { ...target, ...draft }, target.scope === 'project' ? target.projectRef.serverId : serverId, signal),
  remember: (
    target: MemoryDocumentTarget,
    draft: FactDraft,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.remember',
      { ...documentInput(target), ...draft },
      target.serverId,
      signal,
    ),
  /** No document is attached yet: the host picks (and lazily creates) the Session's own target. */
  rememberInSession: (
    target: MemorySessionTarget,
    draft: FactDraft & Readonly<{ topic?: string }>,
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
    input: Readonly<{ factId: string; text: string }>,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.update',
      { ...documentInput(target), ...input },
      target.serverId,
      signal,
    ),
  restore: (
    target: MemoryDocumentTarget,
    factId: string,
    restoreTopic?: string,
    signal?: AbortSignal,
  ) =>
    execute(
      'memory.update',
      {
        ...documentInput(target),
        topic: MEMORY_ARCHIVE_TOPIC_TITLE_V1,
        factId,
        restore: true,
        ...(restoreTopic === undefined ? {} : { restoreTopic }),
      },
      target.serverId,
      signal,
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
