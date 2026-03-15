import type { ClaudeSdkPermissionPolicy } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';

/**
 * Claude execution runs use the SDK backend, which enforces a small set of
 * "permission policies" (legacy execution-run vocabulary).
 *
 * We accept both:
 * - legacy execution-run policies: `no_tools`, `read_only`, `workspace_write`
 * - canonical cross-provider PermissionMode tokens used by UI: `read-only`, `safe-yolo`, `yolo`, etc.
 */
export function resolveClaudeExecutionRunPermissionPolicy(raw: string): ClaudeSdkPermissionPolicy {
  const mode = String(raw ?? '').trim();
  if (!mode) return 'read_only';

  if (mode === 'no_tools' || mode === 'read_only' || mode === 'workspace_write') {
    return mode;
  }

  if (mode === 'read-only') return 'read_only';

  // Any write-like permission intent maps to full tool access for Claude SDK execution runs.
  // (Claude SDK backend uses a single "workspace_write" policy for allowing tool use.)
  if (
    mode === 'safe-yolo' ||
    mode === 'yolo' ||
    mode === 'acceptEdits' ||
    mode === 'bypassPermissions' ||
    mode === 'workspace-write'
  ) {
    return 'workspace_write';
  }

  // Conservative default: preserve "default" / unknown values as read-only tool access.
  return 'read_only';
}

