import type { ClaudeSdkPermissionPolicy } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';

/**
 * Claude execution runs use the SDK backend, which enforces a small set of
 * "permission policies" (legacy execution-run vocabulary).
 *
 * We accept both:
 * - legacy execution-run policies: `no_tools`, `read_only`, `workspace_write`
 * - canonical cross-provider PermissionMode tokens used by UI: `read-only`, `safe-yolo`, `yolo`, etc.
 */
export function resolvePermissionPolicy(raw: string): ClaudeSdkPermissionPolicy {
  const mode = String(raw ?? '').trim();
  if (!mode) return 'read_only';

  if (mode === 'no_tools' || mode === 'read_only' || mode === 'workspace_write') {
    return mode;
  }

  if (mode === 'read-only') return 'read_only';

  // Prompt-capable execution runs need a provider-level control request so the parent
  // session can broker approval and route the response back into the live run.
  if (
    mode === 'safe-yolo' ||
    mode === 'yolo' ||
    mode === 'acceptEdits' ||
    mode === 'bypassPermissions' ||
    mode === 'workspace-write' ||
    mode === 'auto'
  ) {
    return 'parent_session_prompt';
  }

  // Conservative default: preserve "default" / unknown values as read-only tool access.
  return 'read_only';
}
