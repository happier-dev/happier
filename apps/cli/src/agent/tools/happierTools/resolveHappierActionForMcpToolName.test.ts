import { describe, expect, it } from 'vitest';

import {
  resolveHappierActionForMcpToolName,
  resolveProviderPermissionForHappierAction,
} from './resolveHappierActionForMcpToolName';
import { buildHappierToolsShellBridgeCommand } from './runtime/buildHappierToolsShellBridgeCommand';

describe('resolveHappierActionForMcpToolName', () => {
  it('maps first-party provider-prefixed MCP tool aliases to Happier action ids', () => {
    expect(resolveHappierActionForMcpToolName({
      toolName: 'mcp__happier__session_list',
      input: {},
    })).toBe('session.list');
    expect(resolveHappierActionForMcpToolName({
      toolName: 'happier_action_execute',
      input: { actionId: 'session.status.get' },
    })).toBe('session.status.get');
    expect(resolveHappierActionForMcpToolName({
      toolName: 'happier__session_list',
      input: {},
    })).toBe('session.list');
    expect(resolveHappierActionForMcpToolName({
      toolName: 'happier__action_execute',
      input: { actionId: 'session.status.get' },
    })).toBe('session.status.get');
    expect(resolveHappierActionForMcpToolName({
      toolName: 'mcp__custom__session_list',
      input: {},
    })).toBeNull();
  });

});

describe('resolveProviderPermissionForHappierAction', () => {
  it('delegates confirmation for every recognized Happier Action to the shared Action executor', () => {
    expect(resolveProviderPermissionForHappierAction({
      toolName: 'mcp__happier__session_list',
      input: {},
      permissionMode: 'default',
    })).toEqual({ decision: 'approved', actionId: 'session.list' });

    expect(resolveProviderPermissionForHappierAction({
      toolName: 'mcp__happier__session_status_get',
      input: {},
      permissionMode: 'safe-yolo',
    })).toEqual({ decision: 'approved', actionId: 'session.status.get' });

    expect(resolveProviderPermissionForHappierAction({
      toolName: 'happier_action_execute',
      input: { actionId: 'session.board.item.remove' },
      permissionMode: 'default',
    })).toEqual({ decision: 'approved', actionId: 'session.board.item.remove' });

    expect(resolveProviderPermissionForHappierAction({
      toolName: 'mcp__happier__approval_request_create',
      input: {},
      permissionMode: 'acceptEdits',
    })).toEqual({ decision: 'approved', actionId: 'approval.request.create' });

    expect(resolveProviderPermissionForHappierAction({
      toolName: 'Bash',
      input: {
        command: buildHappierToolsShellBridgeCommand([
          'call',
          '--source',
          'happier',
          '--tool',
          'action_execute',
          '--args-json',
          '{"actionId":"session.board.item.remove"}',
          '--json',
        ]),
      },
      permissionMode: 'default',
    })).toEqual({ decision: 'approved', actionId: 'session.board.item.remove' });
  });

  it.each(['read-only', 'plan'] as const)(
    'keeps the %s permission ceiling authoritative before Action confirmation',
    (permissionMode) => {
      expect(resolveProviderPermissionForHappierAction({
        toolName: 'happier_action_execute',
        input: { actionId: 'session.board.item.remove' },
        permissionMode,
      })).toMatchObject({ decision: 'denied', actionId: 'session.board.item.remove',
        reasonCode: 'permission_exceeds_ceiling', rationale: expect.stringContaining(permissionMode) });

      expect(resolveProviderPermissionForHappierAction({
        toolName: 'mcp__happier__session_board_get',
        input: {},
        permissionMode,
      })).toEqual({ decision: 'approved', actionId: 'session.board.get' });

      expect(resolveProviderPermissionForHappierAction({
        toolName: 'Bash',
        input: {
          command: buildHappierToolsShellBridgeCommand([
            'call',
            '--source',
            'happier',
            '--tool',
            'action_execute',
            '--args-json',
            '{"actionId":"session.board.item.remove"}',
            '--json',
          ]),
        },
        permissionMode,
      })).toMatchObject({ decision: 'denied', actionId: 'session.board.item.remove', reasonCode: 'permission_exceeds_ceiling' });
    },
  );

  it('keeps plan mode reversible through its own session mode and goal controls', () => {
    for (const actionId of ['session.mode.set', 'session.goal.set', 'session.goal.clear'] as const) {
      expect(resolveProviderPermissionForHappierAction({
        toolName: 'happier_action_execute',
        input: { actionId },
        permissionMode: 'plan',
      })).toEqual({ decision: 'approved', actionId });

      expect(resolveProviderPermissionForHappierAction({
        toolName: 'happier_action_execute',
        input: { actionId },
        permissionMode: 'read-only',
      })).toMatchObject({ decision: 'denied', actionId, reasonCode: 'permission_exceeds_ceiling' });
    }
  });

  it('leaves unknown and non-Happier provider tools with the provider permission owner', () => {
    expect(resolveProviderPermissionForHappierAction({
      toolName: 'happier_action_execute',
      input: { actionId: 'unknown.action' },
      permissionMode: 'default',
    })).toEqual({ decision: null, actionId: null });

    expect(resolveProviderPermissionForHappierAction({
      toolName: 'mcp__custom__session_list',
      input: {},
      permissionMode: 'default',
    })).toEqual({ decision: null, actionId: null });
  });
});
