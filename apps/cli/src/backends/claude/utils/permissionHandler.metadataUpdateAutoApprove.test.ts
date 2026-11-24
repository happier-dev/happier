import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import { syncClaudePermissionModeFromMetadata } from './syncPermissionModeFromMetadata';

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
  it('uses a newer YOLO mode for tools with the admitted Safe YOLO mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const signal = new AbortController().signal;
    const mode: EnhancedMode = { permissionMode: 'safe-yolo' };
    try {
      session.lastPermissionModeUpdatedAt = 10;
      handler.admitPromptPermissionMode(mode.permissionMode);
      // A newer client revision need not be later than the daemon's wall clock.
      client.updateMetadata(() => ({ permissionMode: 'yolo', permissionModeUpdatedAt: 11 }));
      syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler });

      const result = handler.handleToolCall('Write', { file_path: '/tmp/test.txt', content: 'x' }, mode, {
        signal, toolUseId: 'toolu_upgraded_write',
      });
      // Dispose can reject this request when the regression incorrectly leaves it pending.
      void result.catch(() => undefined);
      expect(client.agentState.requests).not.toHaveProperty('toolu_upgraded_write');
      await expect(result).resolves.toMatchObject({ behavior: 'allow' });

      handler.admitPromptPermissionMode(mode.permissionMode);
      syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler });
      const nextPrompt = handler.handleToolCall('Write', { file_path: '/tmp/test.txt', content: 'y' }, mode, {
        signal, toolUseId: 'toolu_next_prompt_write',
      });
      expect(client.agentState.requests).toHaveProperty('toolu_next_prompt_write');
      await client.rpcHandlerManager.getHandler('permission')!({ id: 'toolu_next_prompt_write', approved: false });
      await expect(nextPrompt).resolves.toMatchObject({ behavior: 'deny' });
    } finally {
      handler.dispose();
    }
  });

  it('keeps Bash gated after a live YOLO downgrade and an Allow all edits reply', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const signal = new AbortController().signal;
    const mode: EnhancedMode = { permissionMode: 'yolo' };
    const write = (toolUseId: string) => handler.handleToolCall(
      'Write', { file_path: '/tmp/test.txt', content: 'x' }, mode, { signal, toolUseId },
    );
    try {
      handler.admitPromptPermissionMode(mode.permissionMode);
      client.updateMetadata(() => ({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 1 }));
      syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler });

      const pendingWrite = write('toolu_downgraded_write');
      expect(client.agentState.requests).toHaveProperty('toolu_downgraded_write');
      const permissionRpc = client.rpcHandlerManager.getHandler('permission')!;
      await permissionRpc({ id: 'toolu_downgraded_write', approved: true, mode: 'acceptEdits' });
      await expect(pendingWrite).resolves.toMatchObject({ behavior: 'allow' });

      const bash = handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal, toolUseId: 'toolu_bash' });
      expect(client.agentState.requests).toHaveProperty('toolu_bash');
      await permissionRpc({ id: 'toolu_bash', approved: false });
      await expect(bash).resolves.toMatchObject({ behavior: 'deny' });

      // The watcher and launcher may both see the same metadata before the reply is echoed.
      syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler });
      const nextWrite = write('toolu_next_write');
      void nextWrite.catch(() => undefined);
      expect(client.agentState.requests).not.toHaveProperty('toolu_next_write');
      await expect(nextWrite).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      handler.dispose();
    }
  });

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
