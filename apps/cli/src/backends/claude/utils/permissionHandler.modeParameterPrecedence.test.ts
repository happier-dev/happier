import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (mode parameter precedence)', () => {
  it('auto-allows tool calls when mode.permissionMode is bypassPermissions even if handler state is default', async () => {
    const { session } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'bypassPermissions' } as EnhancedMode;

    await expect(
      handler.handleToolCall('Read', { file_path: '/tmp/file.txt' }, mode, { signal: controller.signal }),
    ).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('auto-allows edit tools when mode.permissionMode is acceptEdits even if handler state is default', async () => {
    const { session } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'acceptEdits' } as EnhancedMode;

    await expect(
      handler.handleToolCall(
        'Edit',
        { file_path: '/tmp/file.txt', old_string: 'a', new_string: 'b' },
        mode,
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('reset clears bypassPermissions so default mode requires a permission request', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.handleModeChange('bypassPermissions');
    handler.reset();

    handler.onMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'test-tool-2',
            name: 'Bash',
            input: { command: 'rm -rf /' },
          },
        ],
      },
    } as any);

    const controller = new AbortController();
    const mode = { permissionMode: 'default' } as EnhancedMode;
    void handler.handleToolCall('Bash', { command: 'rm -rf /' }, mode, { signal: controller.signal });

    expect(Object.keys(client.agentState.requests)).toEqual(['test-tool-2']);
  });
});

