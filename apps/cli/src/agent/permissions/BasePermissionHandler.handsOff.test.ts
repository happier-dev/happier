import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { clearActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';
import { ProviderEnforcedPermissionHandler } from './providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';

function fixture() {
  let agentState: AgentState = { requests: {}, completedRequests: {} };
  let metadata: unknown = { work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } };
  const rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager('hands-off-session');
  // This is the session transport/storage boundary; permission and role logic stay real.
  const session = {
    sessionId: 'hands-off-session',
    rpcHandlerManager,
    getAgentStateSnapshot: () => agentState,
    getMetadataSnapshot: () => metadata,
    updateAgentState: (update: (state: AgentState) => AgentState) => { agentState = update(agentState); return agentState; },
  } as unknown as ApiSessionClient;
  return { session, rpcHandlerManager, setMetadata: (value: unknown) => { metadata = value; }, readState: () => agentState };
}

describe('BasePermissionHandler hands-off policy', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ scopeKey: 'permission-test', source: 'network', settingsVersion: 1, settings: accountSettingsParse({}),
      rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  });
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());
  it.each(['codex-like', 'provider-enforced'] as const)('reads current Account deny and refuses unavailable authority before YOLO (%s)', async (kind) => {
    const { session, setMetadata } = fixture();
    setMetadata({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } });
    const handler = kind === 'codex-like'
      ? new CodexLikePermissionHandler({ session, logPrefix: '[HandsOff]' })
      : new ProviderEnforcedPermissionHandler(session, { logPrefix: '[HandsOff]' });
    handler.setPermissionMode('yolo');
    setActiveAccountSettingsSnapshot({ scopeKey: 'permission-test', source: 'network', settingsVersion: 2, settings: accountSettingsParse({}),
      rawSettings: { rolesV1: { overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } }, settingsSecretsReadKeys: [], loadedAtMs: 2 });
    expect(handler.getImmediateDecision('write', 'Write', { path: '/workspace/a' })).toEqual({ decision: 'denied' });
    clearActiveAccountSettingsSnapshot();
    expect(handler.getImmediateDecision('unavailable', 'Write', { path: '/workspace/a' })).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('read', 'Bash', { command: 'git status' })?.decision).not.toBe('denied');
    await handler.reset();
  });
  it.each(['codex-like', 'provider-enforced'] as const)('uses the current host-resolved role ceiling (%s)', async (kind) => {
    const { session, setMetadata } = fixture();
    setMetadata(null);
    let workspaceWrites: 'allow' | 'deny' = 'deny';
    const getWorkspaceWrites = () => workspaceWrites;
    const handler = kind === 'codex-like'
      ? new CodexLikePermissionHandler({ session, logPrefix: '[HandsOff]', getWorkspaceWrites })
      : new ProviderEnforcedPermissionHandler(session, { logPrefix: '[HandsOff]', getWorkspaceWrites });
    handler.setPermissionMode('yolo');
    expect(handler.getImmediateDecision('write', 'Write', { path: '/workspace/a' })).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('spawn', 'mcp__happier__session_spawn_new', {})).toEqual({ decision: 'approved' });
    workspaceWrites = 'allow';
    expect(['approved', 'approved_for_session']).toContain(
      handler.getImmediateDecision('write-allowed', 'Write', { path: '/workspace/a' })?.decision,
    );
    await handler.reset();
  });

  it.each(['codex-like', 'provider-enforced'] as const)('denies writes before YOLO and existing grants, preserving coordination (%s)', async (kind) => {
    const { session, readState } = fixture();
    const handler = kind === 'codex-like'
      ? new CodexLikePermissionHandler({ session, logPrefix: '[HandsOff]' })
      : new ProviderEnforcedPermissionHandler(session, { logPrefix: '[HandsOff]' });
    handler.setPermissionMode('yolo');
    expect(handler.getImmediateDecision('write', 'Write', { path: '/workspace/a', content: 'changed' })).toEqual({ decision: 'denied' });
    await expect(handler.handleToolCall('write', 'Write', { path: '/workspace/a', content: 'changed' })).resolves.toEqual({ decision: 'denied' });
    expect(readState().requests?.write).toBeUndefined();
    expect(handler.getImmediateDecision('spawn', 'mcp__happier__session_spawn_new', {})).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('read', 'Bash', { command: 'git status' })?.decision).not.toBe('denied');
    expect(handler.getImmediateDecision('shell-write', 'Bash', { command: 'git status > changed.txt' })).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('mixed', 'Bash', { command: 'git status && git reset --hard' })).toEqual({ decision: 'denied' });
    await handler.reset();
  });

  it('rechecks a pending user approval after the session becomes hands-off', async () => {
    const { session, setMetadata, rpcHandlerManager } = fixture();
    setMetadata(null);
    const handler = new CodexLikePermissionHandler({ session, logPrefix: '[HandsOff]' });
    const result = handler.handleToolCall('pending-write', 'Write', { path: '/workspace/a' });
    setMetadata({ work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } });
    await rpcHandlerManager.handlers.get('permission')?.({ id: 'pending-write', approved: true, decision: 'approved' });
    await expect(result).resolves.toEqual({ decision: 'denied' });
    await handler.reset();
  });
});
