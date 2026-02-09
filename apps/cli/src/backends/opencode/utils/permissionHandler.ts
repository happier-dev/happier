/**
 * OpenCode Permission Handler
 *
 * Mode-aware:
 * - "yolo": auto-approve
 * - "safe-yolo": auto-approve read-only, prompt for write-like
 * - "read-only": deny write-like
 *
 * OpenCode exposes fine-grained permission kinds (e.g. `external_directory`). Treat known "guard"
 * permissions as write-like so they surface prompts in safe-yolo/default modes.
 */

import type { ApiSessionClient } from '@/api/session/sessionClient';
import {
  CodexLikePermissionHandler,
  type PermissionResult,
  type PendingRequest,
  isDefaultWriteLikeToolName,
} from '@/agent/permissions/CodexLikePermissionHandler';

export type { PermissionResult, PendingRequest };

const OPENCODE_WRITE_LIKE_PERMISSION_KINDS = new Set([
  'external_directory',
  'doom_loop',
]);

export class OpenCodePermissionHandler extends CodexLikePermissionHandler {
  constructor(
    session: ApiSessionClient,
    opts?: { onAbortRequested?: (() => void | Promise<void>) | null },
  ) {
    super({
      session,
      logPrefix: '[OpenCode]',
      onAbortRequested: typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null,
      isWriteLikeToolName: (toolName) => {
        const lower = toolName.toLowerCase();
        return isDefaultWriteLikeToolName(toolName) || OPENCODE_WRITE_LIKE_PERMISSION_KINDS.has(lower);
      },
    });
  }
}
