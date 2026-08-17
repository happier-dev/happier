import type {
  AgentAcpRuntimeDefinition,
  AgentSessionConversationRollbackControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

const GROK_PROMPT_CHECKPOINT_KIND = 'grok_prompt_index';
const GROK_FORK_METHODS = Object.freeze([
  'x.ai/session/fork',
  '_x.ai/session/fork',
] as const);
const GROK_REWIND_NAMESPACES = Object.freeze([
  Object.freeze({
    points: 'x.ai/rewind/points',
    execute: 'x.ai/rewind/execute',
  }),
  Object.freeze({
    points: '_x.ai/rewind/points',
    execute: '_x.ai/rewind/execute',
  }),
] as const);

type RecordLike = Readonly<Record<string, unknown>>;
type GrokPromptCheckpoint = Readonly<{
  kind: typeof GROK_PROMPT_CHECKPOINT_KIND;
  promptIndex: number;
}>;

function record(value: unknown): RecordLike | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : null;
}

function readPromptIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function readCheckpoint(value: unknown): GrokPromptCheckpoint | null {
  const checkpoint = record(value);
  if (checkpoint?.kind !== GROK_PROMPT_CHECKPOINT_KIND) return null;
  const promptIndex = readPromptIndex(checkpoint.promptIndex);
  return promptIndex === null
    ? null
    : Object.freeze({ kind: GROK_PROMPT_CHECKPOINT_KIND, promptIndex });
}

function diagnostic(code: string, message: string) {
  return Object.freeze({ code, severity: 'error' as const, message });
}

export function projectGrokUserMessageProviderCheckpoint(input: JsonValue): JsonValue | null {
  const promptIndex = readPromptIndex(record(record(input)?._meta)?.promptIndex);
  return promptIndex === null
    ? null
    : Object.freeze({ kind: GROK_PROMPT_CHECKPOINT_KIND, promptIndex });
}

type GrokForkInput = Readonly<{
  sourceProviderSessionId: string;
  sourceCwd: string;
  newCwd: string;
  providerCheckpoint?: JsonValue;
}>;

export const GROK_ACP_HISTORY: NonNullable<AgentAcpRuntimeDefinition['history']> = Object.freeze({
  projectUserMessageProviderCheckpoint: projectGrokUserMessageProviderCheckpoint,
  createConversationRollback: createGrokConversationRollbackControl,
  fork: Object.freeze({
    methods: GROK_FORK_METHODS,
    buildParams({ sourceProviderSessionId, sourceCwd, newCwd, providerCheckpoint }: GrokForkInput) {
      if (providerCheckpoint === undefined) {
        return Object.freeze({
          sourceSessionId: sourceProviderSessionId,
          sourceCwd,
          newCwd,
        });
      }
      const checkpoint = readCheckpoint(providerCheckpoint);
      if (!checkpoint) {
        throw new Error('Grok exact-turn fork requires an attested prompt index');
      }
      return Object.freeze({
        sourceSessionId: sourceProviderSessionId,
        sourceCwd,
        newCwd,
        targetPromptIndex: checkpoint.promptIndex,
      });
    },
    readProviderSessionId(response: JsonValue) {
      const newSessionId = record(response)?.newSessionId;
      return typeof newSessionId === 'string'
        && newSessionId.length > 0
        && newSessionId === newSessionId.trim()
        ? newSessionId
        : null;
    },
  }),
});

export function createGrokConversationRollbackControl(
  session: Readonly<{
    getProviderSessionId(): string | null;
    requestExtension(
      methods: readonly [string, ...string[]],
      params: JsonValue,
      options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
    ): Promise<JsonValue>;
  }>,
): AgentSessionConversationRollbackControl {
  const rollback: AgentSessionConversationRollbackControl['rollback'] = async (request, options) => {
    const target = request.affectedTurns.find((turn) => turn.turnId === request.target.turnId);
    const checkpoint = readCheckpoint(target?.providerCheckpoint);
    const promptIndexes = request.affectedTurns
      .map((turn) => readCheckpoint(turn.providerCheckpoint)?.promptIndex)
      .filter((value): value is number => value !== undefined);
    if (
      !target
      || !checkpoint
      || promptIndexes.length !== request.affectedTurns.length
      || new Set(promptIndexes).size !== promptIndexes.length
    ) {
      return {
        status: 'rejected',
        retryable: false,
        diagnostic: diagnostic(
          'grok_rollback_checkpoint_unavailable',
          'Grok rollback requires one exact, unambiguous provider checkpoint per affected turn.',
        ),
      };
    }
    if (
      request.providerSessionId !== request.providerSessionId.trim()
      || session.getProviderSessionId() !== request.providerSessionId
    ) {
      return {
        status: 'rejected',
        retryable: false,
        diagnostic: diagnostic(
          'grok_rollback_provider_session_invalid',
          'Grok rollback requires an exact provider session identity.',
        ),
      };
    }
    if (options?.signal?.aborted) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: diagnostic('grok_rollback_aborted', 'Grok rollback was aborted before dispatch.'),
      };
    }
    let rewindNamespace: (typeof GROK_REWIND_NAMESPACES)[number] | null = null;
    for (const candidate of GROK_REWIND_NAMESPACES) {
      if (options?.signal?.aborted) {
        return {
          status: 'unavailable',
          retryable: false,
          diagnostic: diagnostic('grok_rollback_aborted', 'Grok rollback was aborted before dispatch.'),
        };
      }
      if (session.getProviderSessionId() !== request.providerSessionId) {
        return {
          status: 'rejected',
          retryable: false,
          diagnostic: diagnostic(
            'grok_rollback_provider_session_invalid',
            'Grok rollback requires an exact provider session identity.',
          ),
        };
      }
      try {
        await session.requestExtension(
          [candidate.points],
          { sessionId: request.providerSessionId },
          { signal: options?.signal },
        );
        rewindNamespace = candidate;
        break;
      } catch {
        // A points request is read-only, so probing the observed namespace is safe.
      }
    }
    if (!rewindNamespace) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: diagnostic(
          'grok_rollback_unavailable',
          'Grok does not expose a supported conversation rewind namespace.',
        ),
      };
    }
    if (options?.signal?.aborted) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: diagnostic('grok_rollback_aborted', 'Grok rollback was aborted before dispatch.'),
      };
    }
    if (session.getProviderSessionId() !== request.providerSessionId) {
      return {
        status: 'rejected',
        retryable: false,
        diagnostic: diagnostic(
          'grok_rollback_provider_session_invalid',
          'Grok rollback requires an exact provider session identity.',
        ),
      };
    }
    try {
      const params = {
        sessionId: request.providerSessionId,
        targetPromptIndex: checkpoint.promptIndex,
        force: true,
        mode: 'conversation_only',
      } as const;
      const response = await session.requestExtension(
        [rewindNamespace.execute],
        params,
        { signal: options?.signal },
      );
      const success = record(response)?.success;
      if (success === true) return { status: 'applied' };
      if (success === false) {
        return {
          status: 'rejected',
          retryable: false,
          diagnostic: diagnostic(
            'grok_rollback_rejected',
            'Grok rejected the requested conversation rewind.',
          ),
        };
      }
      return {
        status: 'outcomeUnknown',
        diagnostic: diagnostic(
          'grok_rollback_outcome_unknown',
          'Grok returned no authoritative rewind outcome.',
        ),
      };
    } catch (error) {
      return {
        status: 'outcomeUnknown',
        diagnostic: diagnostic(
          'grok_rollback_outcome_unknown',
          error instanceof Error
            ? error.message
            : 'Grok rewind transport ended without an authoritative outcome.',
        ),
      };
    }
  };
  const reconcile: AgentSessionConversationRollbackControl['reconcile'] = async () => ({
    status: 'outcomeUnknown',
    diagnostic: diagnostic(
      'grok_rollback_outcome_unknown',
      'Grok does not expose a non-destructive exact rewind state probe.',
    ),
  });
  return Object.freeze({
    rollback,
    reconcile,
  });
}
