import { createClaudeLocalPermissionBridgeManager } from '../runtime/terminal/permissions/createLocalPermissionBridgeManager';
import { resolveInitialClaudeRemoteMetaState } from '../remote/resolveInitialClaudeRemoteMetaState';

export type ClaudeRuntimeAdjunctState = Readonly<{
  initialClaudeRemoteMetaState: ReturnType<typeof resolveInitialClaudeRemoteMetaState>;
  initialLocalPermissionBridgeEnabled: boolean;
  initialLocalPermissionBridgeWaitIndefinitely: boolean;
  initialLocalPermissionBridgeTimeoutMs: number | null;
  localPermissionBridgeManager: ReturnType<typeof createClaudeLocalPermissionBridgeManager>;
}>;

export function createClaudeRuntimeAdjunctState(params: Readonly<{
  claudeRemoteMetaDefaults?: Record<string, unknown> | null;
}>): ClaudeRuntimeAdjunctState {
  const initialClaudeRemoteMetaState = resolveInitialClaudeRemoteMetaState({
    metaDefaults: params.claudeRemoteMetaDefaults,
  });
  const initialLocalPermissionBridgeEnabled = initialClaudeRemoteMetaState.claudeLocalPermissionBridgeEnabled === true;
  const initialLocalPermissionBridgeWaitIndefinitely =
    initialClaudeRemoteMetaState.claudeLocalPermissionBridgeWaitIndefinitely === true;
  const initialLocalPermissionBridgeTimeoutMs = initialLocalPermissionBridgeWaitIndefinitely
    ? null
    : initialClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds * 1000;
  const localPermissionBridgeManager = createClaudeLocalPermissionBridgeManager();

  localPermissionBridgeManager.setEnabled({
    enabled: initialLocalPermissionBridgeEnabled,
    responseTimeoutMs: initialLocalPermissionBridgeTimeoutMs,
  });

  return {
    initialClaudeRemoteMetaState,
    initialLocalPermissionBridgeEnabled,
    initialLocalPermissionBridgeWaitIndefinitely,
    initialLocalPermissionBridgeTimeoutMs,
    localPermissionBridgeManager,
  };
}
