import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

export type ClaudeRuntimeActivityProjection = Readonly<
  | { state: 'active'; activeCount: number }
  | { state: 'idle'; activeCount: 0 }
  | { state: 'unknown'; activeCount: 0 }
>;

export type ClaudeRuntimeActivityPublisher = Readonly<{
  publish(projection: ClaudeRuntimeActivityProjection): Promise<void>;
  subscribe(handler: (event: AgentSessionRuntimeEvent) => void): () => void;
}>;

export function createClaudeRuntimeActivityPublisher(params: Readonly<{
  sessionId: string;
}>): ClaudeRuntimeActivityPublisher {
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  let current: ClaudeRuntimeActivityProjection = { state: 'idle', activeCount: 0 };
  let publicationTail: Promise<void> = Promise.resolve();

  const eventFor = (projection: ClaudeRuntimeActivityProjection): AgentSessionRuntimeEvent => ({
    kind: 'runtime-activity-snapshot',
    sessionId: params.sessionId,
    emittedAtMs: Date.now(),
    sequence: sequence++,
    state: projection.state,
    activeCount: projection.activeCount,
  });

  const emit = (projection: ClaudeRuntimeActivityProjection): void => {
    const event = eventFor(projection);
    let firstError: unknown;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };

  return Object.freeze({
    publish(projection) {
      const commit = async (): Promise<void> => {
        if (
          current.state === projection.state
          && current.activeCount === projection.activeCount
        ) return;
        emit(projection);
        current = projection;
      };
      const result = publicationTail.then(commit, commit);
      publicationTail = result.catch(() => undefined);
      return result;
    },
    subscribe(handler) {
      listeners.add(handler);
      handler(eventFor(current));
      return () => listeners.delete(handler);
    },
  });
}
