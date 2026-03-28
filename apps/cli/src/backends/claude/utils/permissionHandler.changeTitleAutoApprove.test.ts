import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('Claude PermissionHandler - title changes', () => {
  it('auto-allows title changes in default mode without creating a permission request', async () => {
    const { session, client } = createPermissionHandlerSessionStub('change-title-default-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const mode: EnhancedMode = { permissionMode: 'default' };
    const signal = new AbortController();

    const result = await handler.handleToolCall(
      'Set session title',
      { title: 'Renamed from Claude' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_change_title_default_1' },
    );

    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_change_title_default_1']).toBeUndefined();
  });
});
