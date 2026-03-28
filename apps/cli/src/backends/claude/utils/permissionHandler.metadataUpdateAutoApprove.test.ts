import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

describe('Claude PermissionHandler - metadata updates while waiting for permission', () => {
  it('auto-approves a pending request when metadata permissionMode flips to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('metadata-update-yolo-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const mode: EnhancedMode = { permissionMode: 'default' };

    const pending = handler.handleToolCall(
      'Write',
      { file_path: '/tmp/metadata-update-auto-approve.txt', content: 'x' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_metadata_change_1' },
    );

    expect(Object.keys(client.agentState.requests)).toContain('toolu_metadata_change_1');

    client.updateMetadata((current) => ({
      ...current,
      permissionMode: 'yolo',
      permissionModeUpdatedAt:
        typeof current.permissionModeUpdatedAt === 'number' ? current.permissionModeUpdatedAt + 1 : 1,
    }));

    const result = await withTimeout(pending, 1_500);
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_metadata_change_1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu_metadata_change_1']).toBeTruthy();
  });
});
