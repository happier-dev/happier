import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, type SessionMetadata } from '@happier-dev/protocol';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { applyPermissionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';

import type { AgentState } from '@/api/types';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createPluginSessionHandleCapabilitiesFactory } from './pluginSessionHandleCapabilities';

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ scopeKey: 'native-mode-effect', source: 'network', settingsVersion: 1,
    settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
});
afterEach(() => resetActiveAccountSettingsSnapshotForTests());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** In-memory Session persistence and server attribution are the process boundaries. */
class SessionBoundary {
  readonly sessionId = 'native-mode-session';
  readonly rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: AgentState = { requests: {}, completedRequests: {} };
  metadata: SessionMetadata = {};
  getAgentStateSnapshot() { return this.agentState; }
  getMetadataSnapshot() { return this.metadata; }
  updateAgentState(updater: (current: AgentState) => AgentState) { this.agentState = updater(this.agentState); }
}

const choices = {
  requirementId: 'mode-offer', source: 'native-engine', choices: [{
    id: 'native-edit-mode', label: 'Accept edits', decision: 'approved', scope: 'session',
    response: { approved: true, decision: 'approved', mode: 'acceptEdits' },
  }],
} as const satisfies NativePermissionChoicesV1;

describe('native permission mode application through Session capabilities', () => {
  it.each(['NativeTool', 'ExitPlanMode'])('persists the selected intent for %s after native ACK and before success, retaining a failed native answer for retry', async toolName => {
    const session = new SessionBoundary();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Native mode]' });
    const nativeApplied = deferred();
    const metadataSaved = deferred();
    const effects: string[] = [];
    let rejectNative = true;
    const live = {
      scopeId: Symbol('native-mode-live'), permissionHandler: handler, readPermissionMode: () => 'default',
      applyPermissionModeIntent: async (permissionMode: string) => {
        effects.push('metadata-start');
        await metadataSaved.promise;
        session.metadata = applyPermissionModeIntentSessionMetadata(session.metadata, { permissionMode, updatedAt: 1 });
        effects.push('metadata-saved');
      },
    };
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      caller: { pluginId: 'acme.native', contributionId: 'native',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'test-generation', installSource: 'npm' } },
      signal: new AbortController().signal, isCurrent: () => true, readAgentId: async () => 'native-test',
      resolveLiveCapabilities: () => live,
    })(session.sessionId);
    const pending = capabilities.permissions!.requestDecision({ requestId: 'mode-request', toolName, nativeChoices: choices }, {
      acknowledgeDecisionApplication: async result => {
        effects.push('native-start');
        expect(result.mode).toBe('acceptEdits');
        if (rejectNative) throw new Error('native choice refused');
        await nativeApplied.promise;
        effects.push('native-applied');
      },
    });
    void pending.catch(() => undefined);
    const answer = { id: 'mode-request', nativeChoice: { requirementId: 'mode-offer', choiceId: 'native-edit-mode' } };
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    try {
      await vi.waitFor(() => expect(session.agentState.requests?.['mode-request']).toBeDefined());
      await expect(rpc(answer)).rejects.toThrow('native choice refused');
      expect(session.metadata).toEqual({});
      expect(session.agentState.requests?.['mode-request']).toBeDefined();
      rejectNative = false;
      let returned = false;
      const response = Promise.resolve(rpc(answer)).then(value => { returned = true; return value; });
      await vi.waitFor(() => expect(effects.filter(effect => effect === 'native-start')).toHaveLength(2));
      expect(effects).not.toContain('metadata-start');
      nativeApplied.resolve();
      await vi.waitFor(() => expect(effects).toContain('metadata-start'));
      expect(returned).toBe(false);
      expect(session.metadata).toEqual({});
      expect(session.agentState.completedRequests?.['mode-request']).toBeUndefined();
      metadataSaved.resolve();
      await expect(response).resolves.toBeUndefined();
      await expect(pending).resolves.toMatchObject({ mode: 'acceptEdits', nativeChoice: answer.nativeChoice });
      expect(resolvePermissionIntentFromSessionMetadata(session.metadata)?.intent).toBe('safe-yolo');
      expect(effects.slice(-3)).toEqual(['native-applied', 'metadata-start', 'metadata-saved']);
    } finally {
      nativeApplied.resolve(); metadataSaved.resolve();
      await handler.reset();
    }
  });
});
