/**
 * OpenCode Permission Handler
 *
 * Uses the shared Codex-like ACP permission mode logic.
 */

import type { ApiSessionClient } from '@/api/apiSession';
import {
  CodexLikePermissionHandler,
  isDefaultWriteLikeToolName,
  type PermissionResult,
  type PendingRequest,
} from '@/agent/permissions/CodexLikePermissionHandler';

export type { PermissionResult, PendingRequest };

export function isOpenCodeWriteLikeToolName(toolName: string): boolean {
  return isDefaultWriteLikeToolName(toolName);
}

export class OpenCodePermissionHandler extends CodexLikePermissionHandler {
  constructor(
    session: ApiSessionClient,
    opts?: { onAbortRequested?: (() => void | Promise<void>) | null },
  ) {
    super({
      session,
      logPrefix: '[OpenCode]',
      isWriteLikeToolName: isOpenCodeWriteLikeToolName,
      onAbortRequested: typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null,
    });
  }
}

