import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createBasicSessionClient, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (permission-request hook)', () => {
  it('invokes hooks.onPermissionRequest when a permission-request message is received', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const onPermissionRequest = vi.fn();

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: createBasicSessionClient() as any,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: { onPermissionRequest },
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'permission-request',
      id: 'perm-1',
      reason: 'Read',
      payload: { toolName: 'Read', input: { path: 'a' } },
    } as any);

    expect(onPermissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      permissionId: 'perm-1',
      toolName: 'Read',
    }));
  });
});

