import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';

const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
const nativeActionIds = [
  'computer.targets.list', 'computer.capture', 'computer.query', 'computer.input',
  'computer.control.status', 'computer.control.interrupt', 'computer.control.handBack', 'computer.target.close',
] as const;

function nativeSpec(id: string) {
  return getActionSpec(ActionIdSchema.parse(id));
}

describe('native computer Action contracts', () => {
  it('admits only exact, value-free credential entry and bounded settlement', () => {
    const requests = {
      'computer.secret.fill': {
        serverId: 'home_1', sessionId: 'session_1', machineId: 'machine_1', purpose: 'Sign in',
        sourceId: 'source_1', target, captureId: 'capture_1',
        geometry: { captureWidth: 100, captureHeight: 80, nativeWidth: 100, nativeHeight: 80,
          originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 80 } },
        field: { fieldId: 'field_1', focusId: 'focus_1' },
      },
      'browser.automation.secret.fill': {
        serverId: 'home_1', sessionId: 'session_1', machineId: 'machine_1', purpose: 'Sign in',
        browserSessionId: 'browser_1', viewId: 'view_1', tabId: 'tab_1', frameId: 'frame_1',
        documentId: 'document_1', navigationGeneration: 3, origin: 'https://example.test',
        field: { fieldId: 'field_1', focusId: 'focus_1', locator: '#password' },
      },
    };
    for (const [id, request] of Object.entries(requests)) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const spec = nativeSpec(id);
      expect(spec.inputSchema.safeParse(request).success, id).toBe(true);
      for (const extra of ['value', 'text', 'clipboard', 'secretRef', 'credentialRead']) {
        expect(spec.inputSchema.safeParse({ ...request, [extra]: 'recognizable-private-value' }).success, extra).toBe(false);
        expect(spec.inputSchema.safeParse({ ...request, field: { ...request.field, [extra]: 'recognizable-private-value' } }).success, extra).toBe(false);
      }
      const { focusId: _focusId, ...unprovedField } = request.field;
      expect(spec.inputSchema.safeParse({ ...request, field: unprovedField }).success).toBe(false);
      expect(spec.outputSchema.safeParse({ status: 'filled', code: 'filled' }).success).toBe(true);
      expect(spec.outputSchema.safeParse({ status: 'refused', code: 'field_verification_unsupported' }).success).toBe(true);
      expect(spec.outputSchema.safeParse({ status: 'unknown', code: 'delivery_unknown' }).success).toBe(true);
      for (const extra of ['value', 'valueHash', 'length', 'resultSummary', 'readback']) {
        expect(spec.outputSchema.safeParse({ status: 'filled', code: 'filled', [extra]: 'recognizable-private-value' }).success, extra).toBe(false);
      }
      expect(spec.outputSchema.safeParse({ status: 'refused', code: 'recognizable-private-value' }).success).toBe(false);
      expect(spec.safety).toBe('danger');
      expect(spec.executionPlacement).toBe('machine');
    }
    const browser = nativeSpec('browser.automation.secret.fill').inputSchema;
    expect(browser.safeParse({ ...requests['browser.automation.secret.fill'], origin: 'https://example.test/login?secret=value' }).success).toBe(false);
    expect(browser.safeParse({ ...requests['browser.automation.secret.fill'], origin: 'invalid-origin' }).success).toBe(false);
  });
  it('admits agent discovery, selection and approved Privacy launch', () => {
    for (const id of ['computer.targets.list', 'computer.target.select', 'computer.permissions.openSettings']) {
      expect(nativeSpec(id).requiredAuthority, id).toBe('account_automation');
      expect(nativeSpec(id).surfaces.agent, id).toBe(true);
    }
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('computer.permissions.openSettings'),
      ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent' })).toBe(true);
    expect(nativeSpec('computer.capture').inputSchema.safeParse({ machineId: 'machine_1' }).success).toBe(true);
    expect(nativeSpec('computer.target.select').inputSchema.safeParse({ machineId: 'machine_1' }).success).toBe(false);
    expect(nativeSpec('computer.target.select').inputSchema.safeParse({ machineId: 'machine_1', requestedTarget: 'Editor' }).success).toBe(true);
    expect(nativeSpec('computer.target.select').inputSchema.safeParse({ machineId: 'machine_1', requestedTarget: ' ' }).success).toBe(false);
  });

  it('admits sandbox recovery as a machine Action with default approval and no caller-authored executable', () => {
    const id = ActionIdSchema.parse('browser.sandbox.install');
    const spec = getActionSpec(id);
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.inputSchema.safeParse({ machineId: 'machine_1' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ machineId: 'machine_1', executablePath: '/other/chrome' }).success).toBe(false);
    expect(isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent' })).toBe(true);
  });

  it('treats choosing the target as selection, not another approval', () => {
    expect(nativeSpec('computer.target.select').safety).toBe('safe');
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('computer.target.select'),
      ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'ui', authority: 'present_user' })).toBe(false);
  });

  it('routes native Actions to machines and floors observation egress and input approval', () => {
    for (const id of nativeActionIds) {
      const spec = nativeSpec(id);
      expect(spec.executionPlacement, id).toBe('machine');
      expect(spec.surfaces.agent, id).toBe(true);
    }
    for (const id of ['computer.targets.list', 'computer.capture', 'computer.query', 'computer.input']) {
      expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse(id), ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent' }), id).toBe(true);
    }
    expect(nativeSpec('computer.input').safety).toBe('danger');
    for (const id of ['computer.control.interrupt', 'computer.control.handBack']) {
      expect(nativeSpec(id).requiredAuthority, id).toBe('account_automation');
      expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse(id),
        ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent' }), id).toBe(true);
    }
    expect(nativeSpec('computer.target.close').requiredAuthority).toBe('present_user');
  });

  it('rejects request authority labels, mixed targets and unsafe native identities', () => {
    const schema = nativeSpec('computer.capture').inputSchema;
    const input = { machineId: 'machine_1', target };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, sessionId: 'forged' }).success).toBe(false);
    expect(schema.safeParse({ ...input, target: { kind: 'display', displayId: ':77' } }).success).toBe(true);
    expect(schema.safeParse({ ...input, target: { kind: 'display', displayId: ':77', pid: 123 } }).success).toBe(false);
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse({ ...input, target: { ...target, pid } }).success).toBe(false);
    }
  });

  it('requires capture-bound input and truthful reference-only observations', () => {
    const schema = nativeSpec('computer.input').inputSchema;
    const input = { machineId: 'machine_1', target, captureId: 'capture_1', operation: { kind: 'click', x: 30, y: 20 } };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ machineId: 'machine_1', target, operation: input.operation }).success).toBe(false);
    expect(schema.safeParse({ ...input, operation: { kind: 'click', x: NaN, y: 20 } }).success).toBe(false);
    const output = {
      status: 'captured', target, sourceId: 'source_1', captureId: 'capture_1',
      geometry: { captureWidth: 100, captureHeight: 80, nativeWidth: 200, nativeHeight: 160,
        originX: 20, originY: 30, scaleX: 2, scaleY: 2, crop: { x: 0, y: 0, width: 100, height: 80 } },
      media: { mediaId: 'media_1', mediaKind: 'image', width: 100, height: 80, sizeBytes: 50,
        file: { sessionId: 'session_1', storage: 'session', path: 'captures/1.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } },
    };
    const outputSchema = nativeSpec('computer.capture').outputSchema;
    expect(outputSchema.safeParse(output).success).toBe(true);
    expect(outputSchema.safeParse({ ...output, media: { ...output.media, base64: 'unsafe' } }).success).toBe(false);
    const { file: _file, ...metadataOnly } = output.media;
    expect(outputSchema.safeParse({ ...output, media: metadataOnly }).success).toBe(false);
    expect(nativeSpec('computer.query').outputSchema.safeParse({ status: 'queried', target, sourceId: 'source_1',
      accessibility: { status: 'partial', reason: 'accessibility_unavailable', nodes: [] } }).success).toBe(true);
  });

  it('requires the controller to disclose unknown native input outcomes after reconnect', () => {
    const schema = nativeSpec('computer.control.status').outputSchema;
    const status = { target, sourceId: 'source_1', controller: 'human', controlEpoch: 1, stopping: false };
    expect(schema.safeParse(status).success).toBe(false);
    expect(schema.safeParse({ ...status, uncertain: false }).success).toBe(true);
    expect(schema.safeParse({ ...status, uncertain: true }).success).toBe(true);
  });

  it('admits per-share access and native picker facts without opening the envelopes', () => {
    const selection = nativeSpec('computer.target.select').inputSchema;
    expect(selection.safeParse({ machineId: 'machine_1', target, access: 'see' }).success).toBe(true);
    expect(selection.safeParse({ machineId: 'machine_1', target, access: 'admin' }).success).toBe(false);
    const listing = nativeSpec('computer.targets.list').outputSchema;
    const result = { targets: [{ target, title: 'Login', appName: 'Editor',
      thumbnail: { mimeType: 'image/png', base64: 'cG5n', width: 160, height: 100 } }],
      grants: { capture: 'granted', input: 'granted' },
      displays: { status: 'unavailable', code: 'display_enumeration_unsupported' } };
    expect(listing.safeParse(result).success).toBe(true);
    expect(listing.safeParse({ ...result, targets: [{ ...result.targets[0], nativeValues: 'secret' }] }).success).toBe(false);
    expect(nativeSpec('computer.target.get').outputSchema.safeParse({ consentGranted: true, selectedTarget: target,
      sourceId: 'source_1', access: 'see', approvalDisplay: { machineDisplayName: 'Workstation',
        requiresTargetSelection: false, appName: 'Editor', access: 'see', target: { kind: 'window', title: 'Login' } } }).success).toBe(true);
  });

  it('redacts activity and input names through the shared active-target presentation owner', () => {
    const status = { target, sourceId: 'source_1', controller: 'agent', controlEpoch: 1, stopping: false, uncertain: false,
      activity: { kind: 'click', targetLabel: 'https://example.test/login?token=secret' },
      activeTarget: { x: 0.5, y: 0.5, width: 0.2, height: 0.1, label: 'https://example.test/login?token=secret' } };
    const parsed = nativeSpec('computer.control.status').outputSchema.safeParse(status);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.stringify(parsed.data)).not.toContain('secret');
    const result = nativeSpec('computer.input').outputSchema.safeParse({ target, sourceId: 'source_1', status: 'dispatched',
      targetLabel: 'https://example.test/login?token=secret' });
    expect(result.success).toBe(true);
    if (result.success) expect(JSON.stringify(result.data)).not.toContain('secret');
    expect(nativeSpec('computer.control.status').outputSchema.safeParse({ ...status, activity: { kind: 'type', text: 'password' } }).success).toBe(false);
  });
});
