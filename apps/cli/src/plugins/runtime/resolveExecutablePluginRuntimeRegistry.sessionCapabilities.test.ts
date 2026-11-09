import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';

import { projectOrdinaryPluginSessionLiveCapabilities } from './context/session/ordinaryPluginSessionLiveCapabilities';
import { createPluginSessionMediaHostAdapter } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionMedia';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { CurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';

describe('ordinary plugin Session-handle live capabilities', () => {
  it('keeps permission and MCP scope live when no media adapter is available', () => {
    const handleToolCall = vi.fn<
      NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['handleToolCall']
    >(async () => ({ decision: 'approved' as const }));
    const permissionHandler = {
      handleToolCall,
      listMediatedPendingRequests: vi.fn<
        NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['listMediatedPendingRequests']
      >(() => ({ requests: [], truncated: false, nextCursor: null })),
      respondToMediatedPendingPermission: vi.fn<
        NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['respondToMediatedPendingPermission']
      >(async () => ({ status: 'rejected', code: 'mediationStateUnavailable' })),
      respondToMediatedPendingUserAction: vi.fn<
        NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['respondToMediatedPendingUserAction']
      >(async () => ({ status: 'rejected', code: 'mediationStateUnavailable' })),
      listMediatedPermissionGrants: vi.fn<
        NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['listMediatedPermissionGrants']
      >(async () => null),
      revokeMediatedPermissionGrant: vi.fn<
        NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['revokeMediatedPermissionGrant']
      >(async () => ({ status: 'rejected', code: 'mediationStateUnavailable' })),
    } satisfies NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>;
    const interactions = Object.freeze({
      askQuestions: vi.fn(),
      requestApproval: vi.fn(),
      confirm: vi.fn(),
      approvals: Object.freeze({
        request: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        watch: vi.fn(),
      }),
    }) satisfies InteractionsService;
    const live = {
      scopeId: Symbol('ordinary-session-scope'),
      permissionHandler,
      readPermissionMode: () => 'default',
      signal: new AbortController().signal,
      isCurrent: () => true,
    } satisfies CurrentSessionCapabilityBinding;

    const projected = projectOrdinaryPluginSessionLiveCapabilities({ live, interactions });

    expect(projected.permissionHandler).toBe(live.permissionHandler);
    expect(projected.interactions).toBe(interactions);
    expect(projected.readPermissionMode()).toBe('default');
    expect(projected.media).toBeUndefined();
  });

  it('publishes trusted plugin media without filesystem declarations and retains Session and path custody', async () => {
    await withTempDir('trusted-plugin-media-', async rootPath => {
      const path = join(rootPath, 'generated.png');
      await writeFile(path, new Uint8Array([1, 2, 3]));
      let currentSessionId: string | null = 'owner-session';
      // Transcript publication is the external persistence/transport boundary.
      const publish = vi.fn(async () => undefined);
      const adapter = createPluginSessionMediaHostAdapter({ agentId: 'fixture', readActiveScope: () => (
        currentSessionId ? { sessionId: currentSessionId, rootPath, sendAgentSessionMediaCommitted: publish } : null
      ) });
      const interactions = { askQuestions: vi.fn(), requestApproval: vi.fn(), confirm: vi.fn(),
        approvals: { request: vi.fn(), get: vi.fn(), list: vi.fn(), watch: vi.fn() } } satisfies InteractionsService;
      const live = { scopeId: Symbol('owner-session'), readPermissionMode: () => 'default',
        createMediaService: authorize => adapter.forAuthorizedSession('owner-session', authorize),
        signal: new AbortController().signal, isCurrent: () => currentSessionId === 'owner-session',
      } satisfies CurrentSessionCapabilityBinding;
      try {
        const projected = projectOrdinaryPluginSessionLiveCapabilities({ live, interactions });
        expect(projected.media).toBeDefined();
        expect(projected.interactions).toBe(interactions);
        expect(projected.readPermissionMode()).toBe('default');
        const source = await projected.media!.registerSourceRoot({ rootPath });
        await source.publishGenerated({ localId: 'generated', path });
        expect(publish).toHaveBeenCalledWith('fixture', expect.objectContaining({ localId: 'generated' }));
        await expect(projected.media!.registerSourceRoot({ rootPath: path })).rejects.toThrow('media_source_root_invalid');
        currentSessionId = 'another-session';
        await expect(source.publishGenerated({ localId: 'wrong-session', path })).rejects.toThrow('media_session_scope_forbidden');
        await expect(projected.media!.registerSourceRoot({ rootPath })).rejects.toThrow('media_session_scope_forbidden');
        currentSessionId = null;
        await expect(source.publishGenerated({ localId: 'retired-session', path })).rejects.toThrow('media_session_scope_forbidden');
        expect(publish).toHaveBeenCalledOnce();
      } finally { adapter.dispose(); }
    });
  });
});
