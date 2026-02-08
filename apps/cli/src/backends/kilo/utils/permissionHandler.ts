/**
 * Kilo Permission Handler
 *
 * Mode-aware (same semantics as other ACP backends). Treat guard-like permission kinds as
 * write-like so they surface prompts in safe-yolo/default modes.
 */

import type { ApiSessionClient } from '@/api/apiSession';
import {
  CodexLikePermissionHandler,
  type PermissionResult,
  type PendingRequest,
  isDefaultWriteLikeToolName,
} from '@/agent/permissions/CodexLikePermissionHandler';

export type { PermissionResult, PendingRequest };

const KILO_WRITE_LIKE_PERMISSION_KINDS = new Set([
  'external_directory',
  'doom_loop',
]);

export class KiloPermissionHandler extends CodexLikePermissionHandler {
  constructor(
    session: ApiSessionClient,
    opts?: { onAbortRequested?: (() => void | Promise<void>) | null },
  ) {
    super({
      session,
      logPrefix: '[Kilo]',
      onAbortRequested: typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null,
      isWriteLikeToolName: (toolName) => {
        const lower = toolName.toLowerCase();
        return isDefaultWriteLikeToolName(toolName) || KILO_WRITE_LIKE_PERMISSION_KINDS.has(lower);
      },
    });
  }
}
