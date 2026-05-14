import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import type { EnhancedMode } from '../runtime/claudeEnhancedMode';
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

  it('auto-allows Happier action-backed MCP tools when Happier approval is the user-facing gate', async () => {
    const { session, client } = createPermissionHandlerSessionStub('happier-action-approval-suppression');
    session.accountSettings = {
      actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      }),
    } as typeof session.accountSettings;
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const pending = handler.handleToolCall(
      'mcp__happier__session_list',
      { limit: 20 },
      { permissionMode: 'default' } satisfies EnhancedMode,
      { signal: new AbortController().signal, toolUseId: 'toolu_session_list_approval_gate_1' },
    );

    expect(client.agentState.requests['toolu_session_list_approval_gate_1']).toBeUndefined();
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
  });
});
