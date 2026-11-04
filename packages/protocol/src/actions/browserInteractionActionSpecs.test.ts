import { describe, expect, it } from 'vitest';

import {
  BrowserAutomationActionRequestV1Schema,
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineEntryV1Schema,
  isBrowserAutomationMutatingActionKind,
} from '../browser/automation/v1.js';
import { getActionSpec, isActionSpecSurfacedOn } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isBrowserRuntimeActionId } from './executor/browser.js';

const request = {
  v: 1, automationRequestId: 'request', browserSessionId: 'browser', viewId: 'view',
  navigationGeneration: 0, requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session' },
  timeoutMs: 2_000,
} as const;

const result = {
  v: 1, automationRequestId: 'request', status: 'succeeded', durationMs: 0,
  adapterKind: 'localPreview', fidelity: 'injectedPage', trustedInput: false,
  navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 0, controlEpochAfter: 0,
} as const;

describe('browser interaction Action contracts', () => {
  it('admits deliberate preset and Fit viewer intents while rejecting caller-defined device tuples', () => {
    const spec = getActionSpec('browser.view.setViewport');
    const command = { kind: 'setViewport', browserSessionId: 'browser', viewId: 'view', commandId: 'emulate' };
    expect(spec.inputSchema.parse({ ...command, emulation: { kind: 'preset', presetId: 'phone' } }))
      .toMatchObject({ emulation: { kind: 'preset', presetId: 'phone' } });
    expect(spec.inputSchema.parse({ ...command, emulation: { kind: 'fitViewer' } }))
      .toMatchObject({ emulation: { kind: 'fitViewer' } });
    for (const emulation of [{ kind: 'preset', presetId: 'invented' },
      { kind: 'preset', presetId: 'phone', width: 500 }, { kind: 'fitViewer', mobile: true }]) {
      expect(spec.inputSchema.safeParse({ ...command, emulation }).success).toBe(false);
    }
    expect(resolveActionApprovalRouting({ actionId: 'browser.view.setViewport', spec,
      context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
  });
  it('exposes the existing daemon view list through the agent Action family', () => {
    const actionId = 'browser.view.list';
    const spec = getActionSpec(actionId);
    expect(isBrowserRuntimeActionId(actionId)).toBe(true);
    expect(isActionSpecSurfacedOn(spec, 'agent')).toBe(true);
    expect(spec.inputSchema.parse({ machineId: 'machine', browserSessionId: 'browser' }))
      .toEqual({ machineId: 'machine', browserSessionId: 'browser' });
    expect(spec.outputSchema?.parse({ protocolVersion: 1, views: [] })).toEqual({ protocolVersion: 1, views: [] });
    expect(spec.sideEffectClass).toBe('read');
    expect(resolveActionApprovalRouting({ actionId, spec,
      context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(false);
  });
  it.each([
    ['clipboardRead', {}, false],
    ['clipboardWrite', { text: '' }, true],
    ['answerDialog', { dialogId: 'dialog', accept: true, promptText: 'Alice' }, true],
    ['download', { downloadId: 'download', offset: 0, byteLength: 32 * 1024 * 1024 }, false],
    ['getInteractionState', {}, false],
  ] as const)('admits %s through the agent Action and browser executor family', (kind, payload, mutating) => {
    const actionId = `browser.automation.${kind}` as const;
    const spec = getActionSpec(actionId);
    expect(isActionSpecSurfacedOn(spec, 'agent')).toBe(true);
    expect(isBrowserRuntimeActionId(actionId)).toBe(true);
    expect(spec.inputSchema.parse({ ...request, actionKind: kind, payload }))
      .toEqual({ ...request, actionKind: kind, payload });
    expect(isBrowserAutomationMutatingActionKind(kind)).toBe(mutating);
    expect(spec.sideEffectClass).toBe(mutating ? 'write' : 'read');
  });

  it('keeps sensitive reads and file uploads approval-required by default and user-waivable', () => {
    for (const actionId of ['browser.automation.clipboardRead', 'browser.automation.clipboardWrite',
      'browser.automation.answerDialog', 'browser.automation.download', 'browser.automation.upload'] as const) {
      const spec = getActionSpec(actionId);
      const context = { surface: 'agent', authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, context }).required, actionId).toBe(true);
      const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
        approvalWaivedSurfaces: { [actionId]: ['agent'] } });
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required, actionId).toBe(false);
    }
    const actionId = 'browser.automation.getInteractionState';
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
      context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(false);
  });

  it('rejects malformed interaction operands before dispatch and keeps payloads closed', () => {
    for (const [actionKind, payload] of [
      ['clipboardRead', { text: 'unexpected' }],
      ['clipboardWrite', {}],
      ['clipboardWrite', { text: 42 }],
      ['answerDialog', { accept: true }],
      ['answerDialog', { dialogId: 'dialog', accept: 'yes' }],
      ['download', { downloadId: 'download', offset: 0 }],
      ['download', { downloadId: 'download', offset: -1, byteLength: 1 }],
      ['download', { downloadId: 'download', offset: 0, byteLength: 0 }],
      ['download', { downloadId: 'download', offset: 0, byteLength: 1, path: '/private/file' }],
      ['getInteractionState', { viewId: 'other' }],
    ]) {
      expect(BrowserAutomationActionRequestV1Schema.safeParse({ ...request, actionKind, payload }).success,
        `${actionKind}: ${JSON.stringify(payload)}`).toBe(false);
    }
  });

  it('shares chooser byte validation with human uploads while preserving selector uploads', () => {
    const spec = getActionSpec('browser.automation.upload');
    const chooser = { chooserId: 'chooser', files: [{ name: 'report.bin', dataBase64: 'AAEC/w==' }] };
    expect(spec.inputSchema.safeParse({ ...request, actionKind: 'upload', payload: chooser }).success).toBe(true);
    for (const files of [[{ name: '../report.bin', dataBase64: 'AAEC/w==' }],
      [{ name: 'report.bin', dataBase64: 'not base64!' }]]) {
      expect(spec.inputSchema.safeParse({ ...request, actionKind: 'upload', payload: { ...chooser, files } }).success)
        .toBe(false);
    }
    expect(spec.inputSchema.safeParse({ ...request, actionKind: 'upload', payload: {
      locator: { kind: 'css', value: 'input[type=file]' }, files: [{ name: 'report.csv', text: 'a,b\n1,2' }],
    } }).success).toBe(true);
  });

  it('returns explicit clipboard and download content intact without admitting it onto timelines', () => {
    const interactions = [
      { kind: 'clipboard', text: 'https://example.com/?token=selected-content' },
      { kind: 'download', downloadId: 'download', name: 'report.bin', offset: 3, dataBase64: '/wABAg==', eof: true },
    ] as const;
    const timeline = { ...result, timelineEntryId: 'entry', browserSessionId: 'browser', viewId: 'view',
      actionKind: 'clipboardRead', requesterKind: 'agent', queuedAtMs: 0 };
    for (const interactionResult of interactions) {
      const actionResult = { ...result, interactionResult };
      expect(BrowserAutomationActionResultV1Schema.parse(actionResult).interactionResult).toEqual(interactionResult);
      expect(getActionSpec('browser.automation.clipboardRead').outputSchema?.safeParse(actionResult).success).toBe(true);
      expect(BrowserAutomationTimelineEntryV1Schema.safeParse({ ...timeline, interactionResult }).success).toBe(false);
      expect(BrowserAutomationActionResultV1Schema.safeParse({ ...result,
        interactionResult: { ...interactionResult, machinePath: '/private/file' } }).success).toBe(false);
    }
    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
  });
});
