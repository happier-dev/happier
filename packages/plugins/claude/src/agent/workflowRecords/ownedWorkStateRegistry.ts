/**
 * Per-session registry of workflow-owned subagent tool-use ids (CWF4).
 *
 * The task work-state derivation (`buildClaudeTaskWorkStatePostSendEffect`) is engine-level and
 * stateless, while the workflow runtime that knows which agents are workflow-owned is per-session
 * (in `turnOperations`). This narrow registry bridges them WITHOUT a parallel write path or a
 * provider-name branch in generic code: the workflow runtime registers a resolver keyed by the
 * Happier session id; the dispatch-time work-state merge consults it by session id and drops
 * workflow-owned rows so a canonical `Workflow` run's agents never ALSO render as top-level
 * task/todo rows.
 *
 * The resolver is read at merge time (not snapshotted) so it always reflects the latest owned set.
 */
const EMPTY_OWNED_IDS: ReadonlySet<string> = new Set<string>();

const resolversBySessionId = new Map<string, () => ReadonlySet<string>>();

/**
 * Register the workflow-owned tool-use id resolver for a session. Returns a disposer that removes the
 * registration (call on runtime dispose). Re-registering replaces the previous resolver.
 */
export function registerClaudeWorkflowOwnedToolUseIds(
  sessionId: string,
  resolve: () => ReadonlySet<string>,
): () => void {
  if (!sessionId) return () => {};
  resolversBySessionId.set(sessionId, resolve);
  return () => {
    if (resolversBySessionId.get(sessionId) === resolve) {
      resolversBySessionId.delete(sessionId);
    }
  };
}

/** Resolve the current workflow-owned tool-use ids for a session (empty set when none registered). */
export function resolveClaudeWorkflowOwnedToolUseIds(sessionId: string | undefined): ReadonlySet<string> {
  if (!sessionId) return EMPTY_OWNED_IDS;
  const resolver = resolversBySessionId.get(sessionId);
  if (!resolver) return EMPTY_OWNED_IDS;
  try {
    return resolver();
  } catch {
    return EMPTY_OWNED_IDS;
  }
}
