import { describe, expect, it } from 'vitest';

import type { ActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

async function loadRoutingResolver() {
  const module = await import('./actionApprovalPolicy.js') as Record<string, unknown>;
  const resolver = module.resolveActionApprovalRouting;
  expect(resolver).toEqual(expect.any(Function));
  if (typeof resolver !== 'function') return null;
  return resolver as (args: unknown) => unknown;
}

describe('isApprovalRequiredByActionsSettings', () => {
  it('returns true when the action override requires approvals for the given surface', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'review.start': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'cli' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'mcp' } as any)).toBe(false);
  });

  it('allows requiring approvals for session.title.set when configured', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'session.title.set': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli', 'mcp'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings('session.title.set' as any, settings, { surface: 'cli' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('session.title.set' as any, settings, { surface: 'mcp' } as any)).toBe(true);
  });

  it('returns a non-required routing decision when settings do not require the surface', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'session.list': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli'],
        },
      } as any,
    };

    expect(resolveActionApprovalRouting({
      actionId: 'session.list' as any,
      spec: getActionSpec('session.list'),
      settings,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: false,
      flow: 'blocking',
      result: 'required',
    });
  });

  it('routes required-result read actions as blocking when approval is required', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'session.list' as any,
      spec: getActionSpec('session.list'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: true,
      flow: 'blocking',
      result: 'required',
    });
  });

  it('routes no-result mutation actions as deferred when approval is required', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'session.title.set' as any,
      spec: getActionSpec('session.title.set'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: true,
      flow: 'deferred',
      result: 'none',
    });
  });

  it('routes optional-result actions through their explicit flow', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'session.message.send' as any,
      spec: getActionSpec('session.message.send'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: true,
      flow: 'deferred',
      result: 'optional',
    });
  });

  it('never requires approval for approval decision actions', async () => {
    const resolveActionApprovalRouting = await loadRoutingResolver();
    if (!resolveActionApprovalRouting) return;
    expect(resolveActionApprovalRouting({
      actionId: 'approval.request.decide' as any,
      spec: getActionSpec('approval.request.decide'),
      requiredByPolicy: true,
      context: { surface: 'mcp' } as any,
    })).toEqual({
      required: false,
      flow: 'deferred',
      result: 'none',
    });
  });
});
