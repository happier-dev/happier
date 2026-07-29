import { afterEach, describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import {
  resolveHappierActionForMcpToolName,
  shouldSuppressProviderPermissionForHappierApproval,
} from './resolveHappierActionForMcpToolName';

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

describe('shouldSuppressProviderPermissionForHappierApproval', () => {
  const envScope = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);

  afterEach(() => {
    envScope.restore();
  });

  it('suppresses provider prompts only when first-party Happier action approval is required', () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': {
          disabledSurfaces: [],
          approvalRequiredSurfaces: ['agent'],
        },
      },
    });

    expect(shouldSuppressProviderPermissionForHappierApproval({
      toolName: 'mcp__happier__session_list',
      input: {},
      surface: 'agent',
    })).toEqual({ suppress: true, actionId: 'session.list' });

    expect(shouldSuppressProviderPermissionForHappierApproval({
      toolName: 'mcp__happier__session_status_get',
      input: {},
      surface: 'agent',
    })).toEqual({ suppress: false, actionId: 'session.status.get' });

    expect(shouldSuppressProviderPermissionForHappierApproval({
      toolName: 'mcp__custom__session_list',
      input: {},
      surface: 'agent',
    })).toEqual({ suppress: false, actionId: null });
  });

  it('does not suppress provider prompts for approval actions even when settings require approval', () => {
    const rawActionsSettings: unknown = {
      v: 1,
      actions: {
        'approval.request.create': {
          approvalRequiredSurfaces: ['agent'],
        },
      },
    };

    expect(shouldSuppressProviderPermissionForHappierApproval({
      toolName: 'mcp__happier__approval_request_create',
      input: {},
      surface: 'agent',
      accountSettings: {
        actionsSettingsV1: ActionsSettingsV1Schema.parse(rawActionsSettings),
      },
    })).toEqual({ suppress: false, actionId: 'approval.request.create' });
  });
});
