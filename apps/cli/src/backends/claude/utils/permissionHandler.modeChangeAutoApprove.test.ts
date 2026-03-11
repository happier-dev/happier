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

describe('Claude PermissionHandler - mode change auto-approve', () => {
  it('auto-approves a pending non-interactive request when switching to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('mode-change-yolo-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const mode: EnhancedMode = { permissionMode: 'default' };

    const pending = handler.handleToolCall(
      'Change Title',
      { title: 'x' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_mode_change_1' },
    );

    // Ensure the request is actually pending before switching modes.
    expect(Object.keys(client.agentState.requests)).toContain('toolu_mode_change_1');

    handler.handleModeChange('yolo');

    const result = await Promise.race([pending, timeout(1_000)]);
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_mode_change_1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu_mode_change_1']).toBeTruthy();
  });

  it('auto-approves pending edit tools when switching to safe-yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('mode-change-safe-yolo-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const mode: EnhancedMode = { permissionMode: 'default' };

    const pending = handler.handleToolCall(
      'Write',
      { file_path: '/tmp/a.txt', content: 'hi' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_mode_change_2' },
    );

    expect(Object.keys(client.agentState.requests)).toContain('toolu_mode_change_2');

    handler.handleModeChange('safe-yolo');

    const result = await Promise.race([pending, timeout(1_000)]);
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_mode_change_2']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu_mode_change_2']).toBeTruthy();
  });
});

