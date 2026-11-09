import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

const inputs = {
  'screenCapture.start': { mode: 'screenshot', target: { kind: 'frontmost' },
    targetSession: { serverId: 'home', accountId: 'account', sessionId: 'session' } },
  'screenCapture.copy': { captureRef: 'kept-capture' },
  'screenCapture.showInFolder': { captureRef: 'kept-capture' },
  'screenCapture.targets.list': {},
  'screenCapture.permissions.read': {},
  'screenCapture.permissions.request': { subject: 'window_text' },
  'screenCapture.windowText.read': { captureRef: 'kept-capture' },
  'screenCapture.recent.list': {},
};

describe('native screen capture Action admission', () => {
  it('classifies frame copy at the same content-disclosure boundary as a recording frame read', () => {
    const input = { captureRef: 'kept-capture', frameAtMs: 2000 };
    expect(getActionSpec('screenCapture.copy').safetyForInput?.(input)).toBe('danger');
    expect(getActionSpec('screenCapture.copy').safetyForInput?.(input))
      .toBe(getActionSpec('screenCapture.recording.read').safetyForInput?.(input));
  });

  it.each([{ captureRef: 'kept-capture', content: 'windowText' }, { captureRef: 'kept-capture', frameAtMs: 2000 }])(
    'asks before automated copy disclosure and permits a direct UI copy: %o', input => {
      const settings = ActionsSettingsV1Schema.parse({ v: 1 });
      for (const surface of ['agent', 'mcp'] as const) {
        expect(isApprovalRequiredByActionsSettings('screenCapture.copy', settings,
          { surface, authority: 'account_automation', actionCaller: { kind: 'host' } }, undefined, undefined, input)).toBe(true);
      }
      expect(isApprovalRequiredByActionsSettings('screenCapture.copy', settings,
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }, undefined, undefined, input)).toBe(false);
      const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.copy': ['agent'] } });
      expect(isApprovalRequiredByActionsSettings('screenCapture.copy', waived,
        { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } }, undefined, undefined, input)).toBe(false);
    });

  it('uses Start for frontmost capture without declaring a second capture Action', () => {
    expect(ActionIdSchema.safeParse('screenCapture.frontmostWindow').success).toBe(false);
    const start = getActionSpec('screenCapture.start');
    expect(start.inputSchema.safeParse(inputs['screenCapture.start']).success).toBe(true);
    expect(start.approvalPolicy.agentDefault).toBe('egress');
  });

  it('returns uploaded frontmost media and optional disclosed window text from Start', () => {
    const output = getActionSpec('screenCapture.start').outputSchema;
    const delivered = { captureRef: 'kept-capture', media: { mediaId: 'image', mediaKind: 'image',
      width: 2, height: 2, sizeBytes: 12, file: { sessionId: 'session', storage: 'session', path: '/capture.png',
        sha256: 'a'.repeat(64), mimeType: 'image/png' } } };
    expect(output.safeParse(delivered).success).toBe(true);
    expect(output.safeParse({ ...delivered, windowText: { text: 'Included window content', name: 'Window text.txt' } }).success).toBe(true);
    expect(output.safeParse({ ...delivered, windowText: { text: 'Missing attachment name' } }).success).toBe(false);
    const { file: _file, ...unuploaded } = delivered.media;
    expect(output.safeParse({ ...delivered, media: unuploaded }).success).toBe(false);
  });

  it('uses the approved screenshot mode without exposing the native still spelling', () => {
    const input = getActionSpec('screenCapture.start').inputSchema;
    expect(input.safeParse({ mode: 'screenshot' }).success).toBe(true);
    expect(input.safeParse({ mode: 'still' }).success).toBe(false);
  });
  it.each(Object.entries(inputs))('declares strict client inputs and disclosure defaults for %s', (name, input) => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
      const parsed = ActionIdSchema.safeParse(name);
      expect(parsed.success, name).toBe(true);
      if (!parsed.success) return;
      const spec = getActionSpec(parsed.data);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, marks: [] }).success).toBe(false);
      expect(isApprovalRequiredByActionsSettings(parsed.data, settings,
        { surface: 'agent', authority: 'account_automation' })).toBe(!['screenCapture.permissions.read', 'screenCapture.showInFolder'].includes(name));
      expect(isApprovalRequiredByActionsSettings(parsed.data, settings,
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toBe(false);
  });

  it('accepts extracted text through the existing window-text Action without accepting stale text on an empty result', () => {
    const output = getActionSpec('screenCapture.windowText.read').outputSchema;
    const source = { appName: 'Editor', windowTitle: 'Chosen window', windowId: 7 };
    expect(output.safeParse({ captureRef: 'kept-capture', status: 'ready', text: 'Selected window content', source }).success).toBe(true);
    expect(output.safeParse({ captureRef: 'kept-capture', status: 'empty', source }).success).toBe(true);
    expect(output.safeParse({ captureRef: 'kept-capture', status: 'empty', text: 'Stale window content', source }).success).toBe(false);
    expect(output.safeParse({ captureRef: 'kept-capture', status: 'partial', text: 'Readable portion', reason: 'permission_required', source }).success).toBe(true);
    expect(output.safeParse({ captureRef: 'kept-capture', status: 'partial', text: 'Readable portion', reason: 'ambiguous_target', source }).success).toBe(false);
    expect(output.safeParse({ captureRef: 'kept-capture', status: 'unavailable', reason: 'target_unavailable', source: null }).success).toBe(true);
    const frontmost = { appName: 'Editor', windowTitle: 'Before the portal', windowId: null };
    for (const outcome of [
      { status: 'ready', text: 'Whole frontmost content', source: frontmost },
      { status: 'empty', source: frontmost },
      { status: 'partial', text: 'Readable portion', reason: 'permission_required', source: frontmost },
      { status: 'unavailable', reason: 'no_window_context', source: null },
    ]) {
      expect(output.safeParse({ captureRef: 'portal-capture', ...outcome, scope: 'whole_frontmost_window' }).success).toBe(true);
      expect(output.safeParse({ captureRef: 'portal-capture', ...outcome, scope: 'portal_crop' }).success).toBe(false);
    }
  });

});
