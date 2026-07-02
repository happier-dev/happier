import { ClaudeLocalPermissionBridge, DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE } from './localPermissionBridge';

import type { Session } from '../../session/ClaudeSession';
import type { PermissionHookData, PermissionHookResponse } from '@happier-dev/plugins-claude/agent';

export type ClaudeLocalPermissionBridgeManager = Readonly<{
  setSession: (session: Session | null) => void;
  setEnabled: (params: Readonly<{ enabled: boolean; responseTimeoutMs: number | null }>) => boolean;
  activateIfPresent: () => void;
  handlePermissionHook: (data: PermissionHookData) => Promise<PermissionHookResponse>;
  dispose: () => void;
}>;

export function createClaudeLocalPermissionBridgeManager(): ClaudeLocalPermissionBridgeManager {
  let session: Session | null = null;
  let enabled = false;
  let responseTimeoutMs: number | null = null;
  let bridge: ClaudeLocalPermissionBridge | null = null;

  const rebuild = () => {
    bridge?.dispose();
    bridge = null;
    if (!enabled || !session) return;
    bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs });
    bridge.activate();
  };

  return Object.freeze({
    setSession(nextSession: Session | null) {
      session = nextSession;
      rebuild();
    },
    setEnabled(params) {
      const didChange = params.enabled !== enabled || params.responseTimeoutMs !== responseTimeoutMs;
      enabled = params.enabled;
      responseTimeoutMs = params.responseTimeoutMs;
      if (didChange) {
        rebuild();
      }
      return didChange;
    },
    activateIfPresent() {
      bridge?.activate();
    },
    async handlePermissionHook(data) {
      if (!enabled || !bridge) {
        return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
      }
      return await bridge.handlePermissionHook(data);
    },
    dispose() {
      bridge?.dispose();
      bridge = null;
    },
  });
}
