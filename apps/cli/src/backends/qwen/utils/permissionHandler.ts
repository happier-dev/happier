/**
 * Qwen Permission Handler
 *
 * Mode-aware permission handler for ACP sessions.
 */

import type { ApiSessionClient } from '@/api/apiSession';
import {
  CodexLikePermissionHandler,
  type PermissionResult,
  type PendingRequest,
} from '@/agent/permissions/CodexLikePermissionHandler';

export type { PermissionResult, PendingRequest };

export class QwenPermissionHandler extends CodexLikePermissionHandler {
  constructor(
    session: ApiSessionClient,
    opts?: { onAbortRequested?: (() => void | Promise<void>) | null },
  ) {
    super({
      session,
      logPrefix: '[Qwen]',
      onAbortRequested: typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null,
    });
  }
}
