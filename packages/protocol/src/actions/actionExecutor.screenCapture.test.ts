import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor as createExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, listActionSpecsForSurface } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
const session = { serverId: 'home', sessionId: 'session', accountId: 'account' };

it('returns the addressed capture pin and its default provenance from an admitted open', async () => {
  const opened = { captureRef: 'capture-2', status: 'opened', targetSession: session, defaultReason: 'lastCapturePick' } as const;
  const executor = createActionExecutor({ screenCaptureAction: async () => opened, isActionApprovalRequired: () => false });
  expect(await executor.execute('screenCapture.open', { captureRef: 'capture-2' }, person)).toEqual({ ok: true, result: opened });
});

function createActionExecutor(deps: Partial<ActionExecutorDeps>) {
  // This boundary fixture supplies only exercised adapters, never a replacement for executor logic.
  return createExecutor(deps as ActionExecutorDeps);
}

describe('screen capture delivery Action admission', () => {
  it('keeps the system source handoff typed until the person continues or cancels it', async () => {
    const selection = { status: 'system_selection', operationRef: 7, mode: 'recording' };
    const executor = createActionExecutor({ screenCaptureAction: async () => selection });
    expect(await executor.execute('screenCapture.start', { mode: 'recording' }, person)).toEqual({ ok: true, result: selection });
  });
  it('preserves prepared recording delivery summaries through the existing delivery and start outputs', async () => {
    const summary = { frameCount: 2, durationMs: 1500, byteSize: 4000, includeVideo: true };
    const appended = { captureRef: 'movie', imageNumber: 1, imageNumbers: [1, 2], summary, waiting: false };
    const sent = { captureRef: 'movie', messageRef: 'message', summary };
    for (const [id, input, output] of [
      ['screenCapture.addToDraft', { captureRef: 'movie', session }, appended],
      ['screenCapture.send', { captureRef: 'movie', session }, sent],
      ['screenCapture.start', { mode: 'recording' }, appended],
    ] as const) {
      const executor = createActionExecutor({ screenCaptureAction: async () => output });
      expect(await executor.execute(id, input, person)).toEqual({ ok: true, result: output });
    }
  });
  it('declares reversible recording edits and warning decisions without marks and asks only for frame pixels', () => {
    const editId = ActionIdSchema.safeParse('screenCapture.recording.edit');
    const readId = ActionIdSchema.safeParse('screenCapture.recording.read');
    expect(editId.success && readId.success).toBe(true);
    if (!editId.success || !readId.success) return;
    const edit = getActionSpec(editId.data);
    expect(edit.inputSchema.safeParse({ captureRef: 'movie', operations: [
      { kind: 'trim.set', startMs: 1000, endMs: 2000 }, { kind: 'pin.add', sourceTimeMs: 1500 },
      { kind: 'note.set', id: 'words', sourceTimeMs: 1500, text: 'Observe this' },
      { kind: 'includeVideo.set', mode: 'on' }, { kind: 'windowText.set', included: true },
    ] }).success).toBe(true);
    expect(edit.inputSchema.safeParse({ captureRef: 'movie', operations: [{ kind: 'pin.add', sourceTimeMs: 1234.5 }] }).success).toBe(false);
    for (const operation of [{ kind: 'disclosure.warning', include: true }, { kind: 'windowText.warning', include: true }]) {
      expect(edit.inputSchema.safeParse({ captureRef: 'movie', operations: [operation] }).success).toBe(true);
    }
    for (const operation of [{ kind: 'disclosure.warning', include: 'yes' }, { kind: 'windowText.warning', include: 'yes' },
      { kind: 'frame.document', sourceTimeMs: 1000, document: {} }]) {
      expect(edit.inputSchema.safeParse({ captureRef: 'movie', operations: [operation] }).success).toBe(false);
    }
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const read = getActionSpec(readId.data);
    expect(read.inputSchema.safeParse({ captureRef: 'movie', frameAtMs: 1234.5 }).success).toBe(false);
    for (const surface of ['agent', 'mcp'] as const) {
      for (const input of [{ captureRef: 'movie' }, { captureRef: 'movie', frameAtMs: 1500 }]) {
        expect(read.inputSchema.safeParse(input).success).toBe(true);
        expect(isApprovalRequiredByActionsSettings(readId.data, settings, { surface, authority: 'account_automation' },
          read.safetyForInput?.(input), undefined, input)).toBe('frameAtMs' in input);
      }
    }
  });
  it('declares one recording start and Direct lifecycle continuations without accepting marks', () => {
    for (const name of ['screenCapture.start', 'screenCapture.recording.status', 'screenCapture.recording.pause', 'screenCapture.recording.resume', 'screenCapture.recording.stop']) {
      const parsed = ActionIdSchema.safeParse(name);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const spec = getActionSpec(parsed.data);
      const input = name.endsWith('.start') ? { mode: 'recording' } : { operationRef: 1 };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, marks: [] }).success).toBe(false);
      const settings = ActionsSettingsV1Schema.parse({ v: 1 });
      expect(isApprovalRequiredByActionsSettings(parsed.data, settings, { surface: 'agent', authority: 'account_automation' })).toBe(name === 'screenCapture.start');
      expect(isApprovalRequiredByActionsSettings(parsed.data, settings, person)).toBe(false);
    }
  });
  it('exposes one client path for open, delivery and discard, with strict disclosure inputs', () => {
    for (const name of ['screenCapture.open', 'screenCapture.addToDraft', 'screenCapture.send', 'screenCapture.discard']) {
      const id = ActionIdSchema.parse(name);
      const spec = getActionSpec(id);
      expect(spec.executionPlacement).toBe('client');
      for (const surface of ['ui', 'agent', 'mcp'] as const) expect(listActionSpecsForSurface(surface).some(item => item.id === id)).toBe(true);
      const input = { captureRef: 'capture', ...(name.endsWith('send') || name.endsWith('addToDraft') ? { session } : {}) };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      if (name.endsWith('send') || name.endsWith('addToDraft')) expect(spec.invocationServerIdForInput?.(input)).toBe(session.serverId);
      expect(spec.inputSchema.safeParse({ ...input, marks: [] }).success).toBe(false);
      expect(spec.inputSchema.safeParse({ ...input, includeWindowText: true }).success).toBe(false);
      const settings = ActionsSettingsV1Schema.parse({ v: 1 });
      expect(isApprovalRequiredByActionsSettings(id, settings, person)).toBe(false);
      expect(isApprovalRequiredByActionsSettings(id, settings, { surface: 'agent', authority: 'account_automation' })).toBe(name.endsWith('send') || name.endsWith('addToDraft'));
    }
  });

  it('refuses malformed and disabled requests before any capture effect', async () => {
    const id = ActionIdSchema.parse('screenCapture.send');
    const requests: unknown[] = [];
    let enabled = false;
    const executor = createActionExecutor({
      isActionEnabled: () => enabled,
      isActionApprovalRequired: () => false,
      clientActionExecute: async request => { requests.push(request.input); return { ok: true, result: { captureRef: 'capture', messageRef: 'message' } }; },
    });
    const agent = { surface: 'agent', authority: 'account_automation' } as const;
    expect(await executor.execute(id, { captureRef: 'capture', session }, agent)).toMatchObject({ ok: false });
    enabled = true;
    expect(await executor.execute(id, { captureRef: 'capture', session, includeWindowText: true }, agent)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toEqual([]);
    expect(await executor.execute(id, { captureRef: 'capture', session }, agent)).toEqual({ ok: true, result: { captureRef: 'capture', messageRef: 'message' } });
    expect(requests).toHaveLength(1);
  });

  it.each(['agent', 'mcp'] as const)('asks before screen disclosure on %s and preserves explicit waiver', async surface => {
    const id = ActionIdSchema.parse('screenCapture.send');
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const delivered: unknown[] = [];
    const deps = {
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async () => ({ artifactId: 'capture-decision' }),
      approvalsUpdate: async () => ({ ok: true as const }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const,
        request: { ...request, status: 'rejected' as const, decision: { kind: 'reject' as const, decidedAtMs: Date.now() } } }),
      screenCaptureAction: async request => { delivered.push(request.input); return { captureRef: 'capture', messageRef: 'message' }; },
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps);
    const context = { surface, authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'account', actionRequestId: 'capture-decision', defaultSessionMachineId: 'client' } as const;
    expect(await executor.execute(id, { captureRef: 'capture', session }, context))
      .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(delivered).toEqual([]);
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [id]: [surface] } });
    expect(await executor.execute(id, { captureRef: 'capture', session }, context)).toEqual({ ok: true, result: { captureRef: 'capture', messageRef: 'message' } });
    expect(delivered).toHaveLength(1);
  });
});
