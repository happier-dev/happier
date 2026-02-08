import { describe, expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';

function createSessionStub(initialMetadata: any) {
  let metadata = initialMetadata;

  return {
    sessionId: 's-test',
    rpcHandlerManager: new RpcHandlerManager({
      scopePrefix: 's-test',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      logger: () => undefined,
    }),
    getMetadataSnapshot: () => metadata,
    setMetadata: (next: any) => {
      metadata = next;
    },
    updateAgentState: (_updater: (current: any) => any) => {},
    getAgentStateSnapshot: () => ({ requests: {}, completedRequests: {} }),
  } as any;
}

describe('CodexLikePermissionHandler (metadata sync)', () => {
  it('adopts newer permissionMode from session metadata before deciding a tool call', async () => {
    const session = createSessionStub({ permissionMode: 'yolo', permissionModeUpdatedAt: 100 });
    const handler = new CodexLikePermissionHandler({ session, logPrefix: '[test]' });

    handler.setPermissionMode('yolo');

    // Simulate a metadata-only permission mode update arriving mid-turn.
    session.setMetadata({ permissionMode: 'read-only', permissionModeUpdatedAt: 200 });

    const res = await handler.handleToolCall('t1', 'bash', { command: 'echo hi' });
    expect(res.decision).toBe('denied');
  });
});

