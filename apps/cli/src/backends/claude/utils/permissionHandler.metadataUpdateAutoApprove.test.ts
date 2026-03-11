import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });
}

describe('Claude PermissionHandler - metadata updates while waiting for permission', () => {
  it('auto-approves a pending request when metadata permissionMode flips to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('metadata-update-yolo-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const mode: EnhancedMode = { permissionMode: 'default' };

    const pending = handler.handleToolCall(
      'Change Title',
      { title: 'x' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_metadata_change_1' },
    );

    expect(Object.keys(client.agentState.requests)).toContain('toolu_metadata_change_1');

    client.updateMetadata((current) => ({
      ...current,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
    }));

    const result = await Promise.race([pending, timeout(1_500)]);
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_metadata_change_1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu_metadata_change_1']).toBeTruthy();
  });
});

