import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('Claude PermissionHandler - mode change auto-approve', () => {
  it('does not persist transient runtime mode changes as sticky session intent', async () => {
    const { session } = createPermissionHandlerSessionStub('mode-change-runtime-only');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.handleModeChange('yolo');

    expect(session.setLastPermissionMode).not.toHaveBeenCalled();
  });

  it('auto-approves a pending non-interactive request when switching to yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('mode-change-yolo-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const mode: EnhancedMode = { permissionMode: 'default' };

    const pending = handler.handleToolCall(
      'Write',
      { file_path: join(tmpdir(), 'permission-handler-mode-change.txt'), content: 'x' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_mode_change_1' },
    );

    // Ensure the request is actually pending before switching modes.
    expect(Object.keys(client.agentState.requests)).toContain('toolu_mode_change_1');

    handler.handleModeChange('yolo');

    const result = await withTimeout(pending, 1_000);
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_mode_change_1']).toBeUndefined();
    expect(client.agentState.completedRequests['toolu_mode_change_1']).toBeTruthy();
  });

  it('keeps an unresolved edit pending when switching to safe-yolo', async () => {
    const { session, client } = createPermissionHandlerSessionStub('mode-change-safe-yolo-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const mode: EnhancedMode = { permissionMode: 'default' };

    const filePath = join(tmpdir(), 'happier-permission-handler-mode-change.txt');
    const pending = handler.handleToolCall(
      'Write',
      { file_path: filePath, content: 'hi' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_mode_change_2' },
    );

    expect(Object.keys(client.agentState.requests)).toContain('toolu_mode_change_2');

    handler.handleModeChange('safe-yolo');

    expect(client.agentState.requests['toolu_mode_change_2']).toBeDefined();
    await client.rpcHandlerManager.getHandler('permission')?.({ id: 'toolu_mode_change_2', approved: false } as any);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('does not let a stale per-turn default mode beat a fresher yolo handler mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('mode-change-stale-default');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.handleModeChange('yolo');

    await expect(
      withTimeout(handler.handleToolCall(
        'Bash',
        { command: 'mkdir -p /tmp/happier-yolo-test && echo created' },
        { permissionMode: 'default' } as EnhancedMode,
        { signal: new AbortController().signal, toolUseId: 'toolu_mode_change_3' },
      ), 1_000),
    ).resolves.toMatchObject({ behavior: 'allow' });

    expect(client.agentState.requests['toolu_mode_change_3']).toBeUndefined();
  });
});
