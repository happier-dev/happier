import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { UiBrowserAutomationDispatchRequestV1Schema } from '../browser/automation/reverseDispatchV1.js';

describe('pre-mount Browser workspace Action contract', () => {
  it('advertises native DevTools with configurable approval and exact mounted-view routing', () => {
    const spec = getActionSpec('browser.view.openDevtools');
    expect(spec).toMatchObject({ executionPlacement: 'machine',
      surfaces: { ui: true, agent: true, plugin: true, api: true, mcp: false, voice: false, cli: false } });
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1 }),
      { surface: 'agent', authority: 'account_automation' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { [spec.id]: ['agent'] } }), { surface: 'agent', authority: 'account_automation' })).toBe(false);
    const input = spec.inputSchema.parse({ browserSessionId: 'browser-session', viewId: 'view', commandId: 'devtools' });
    expect(UiBrowserAutomationDispatchRequestV1Schema.safeParse({ v: 1, sessionId: 'session',
      actionId: spec.id, input, authority: 'account_automation' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, nativeDevtools: true }).success).toBe(false);
    expect(spec.inputHints?.fields.map(field => field.path)).toEqual(expect.arrayContaining(['commandId', 'browserSessionId', 'viewId']));
  });
  it('carries the canonical openExternal input from Machine placement to its exact answering client', () => {
    const spec = getActionSpec('browser.view.openExternal');
    const input = spec.inputSchema.parse({ browserSessionId: 'browser-session', viewId: 'view', commandId: 'open-external' });
    expect(spec.executionPlacement).toBe('machine');
    expect(UiBrowserAutomationDispatchRequestV1Schema.safeParse({ v: 1, sessionId: 'session',
      actionId: spec.id, input, authority: 'account_automation' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, kind: 'openExternal' }).success).toBe(false);
  });
  it('admits a typed target on the client and preserves configurable Agent Ask-first policy', () => {
    const spec = getActionSpec('browser.workspace.open');
    expect(spec).toMatchObject({ safety: 'danger', executionPlacement: 'client',
      surfaces: { ui: true, agent: true, mcp: false, voice: false, cli: false } });
    expect(resolveActionSurfaceAvailability({ actionId: spec.id, surface: 'agent' }))
      .toMatchObject({ available: true });
    const context = { surface: 'agent', authority: 'account_automation' } as const;
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1 }), context)).toBe(true);
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [spec.id]: ['agent'] } });
    expect(isApprovalRequiredByActionsSettings(spec.id, waived, context)).toBe(false);
    const input = { scopeId: 'workspace_1', commandId: 'open_1',
      target: { kind: 'localServicePreview', targetId: 'preview_1', machineId: 'machine_1' } };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ url: 'https://bypass.test/' }, { platform: 'desktop' }, { browserSessionId: 'fake' },
      { targetPolicyDecision: { allowed: true } }, { runtimeAccountId: 'other_account' }]) {
      expect(spec.inputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(spec.inputSchema.safeParse({ ...input, target: { url: 'https://bypass.test/' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, scopeId: '' }).success).toBe(false);
  });
});
