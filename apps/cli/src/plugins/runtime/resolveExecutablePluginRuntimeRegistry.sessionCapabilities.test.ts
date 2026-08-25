import { describe, expect, it, vi } from 'vitest';
import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';

import { projectOrdinaryPluginSessionLiveCapabilities } from './context/session/ordinaryPluginSessionLiveCapabilities';
import type { CurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';

describe('ordinary plugin Session-handle live capabilities', () => {
  it('keeps permission and MCP scope live when no filesystem authority can authorize media', () => {
    const handleToolCall = vi.fn<
      NonNullable<CurrentSessionCapabilityBinding['permissionHandler']>['handleToolCall']
    >(async () => ({ decision: 'approved' as const }));
    const createMediaService = vi.fn();
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
      createMediaService,
      signal: new AbortController().signal,
      isCurrent: () => true,
    } satisfies CurrentSessionCapabilityBinding;

    const projected = projectOrdinaryPluginSessionLiveCapabilities({ live, interactions });

    expect(projected.permissionHandler).toBe(live.permissionHandler);
    expect(projected.interactions).toBe(interactions);
    expect(projected.readPermissionMode()).toBe('default');
    expect(projected.media).toBeUndefined();
    expect(createMediaService).not.toHaveBeenCalled();
  });
});
