import { describe, expect, it } from 'vitest';

import {
  admitVisibleRunBind,
  detectVisibleRunControlsChange,
  readVisibleRunTurnOutputs,
  resolveVisibleRunControls,
} from './visibleRunRules';

const reviewerChild = {
  sessionId: 'reviewer_1',
  archived: false,
  metadata: {
    flavor: 'claude',
    permissionMode: 'read-only',
    modelOverrideV1: { v: 1, updatedAt: 1, modelId: 'claude-opus-5-5' },
    sessionRoleV1: { v: 1, role: 'reviewer', instructions: 'Review.', assignmentId: 'a1', assignedAt: 1 },
    sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'x' } },
  },
};
const reviewControls = resolveVisibleRunControls({
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', modelId: 'claude-opus-5-5',
});

describe('admitVisibleRunBind', () => {
  const admit = (overrides: Partial<Parameters<typeof admitVisibleRunBind>[0]> = {}) => admitVisibleRunBind({
    hostingSessionId: 'lead', intent: 'review', child: reviewerChild, busy: false, controls: reviewControls, ...overrides,
  });

  it('admits the hosting session\'s own reviewer whose controls already equal the run\'s', () => {
    expect(admit()).toEqual({ ok: true, childRole: 'reviewer', childAssignmentId: 'a1' });
  });

  it('rejects a foreign child, a role mismatch, a busy child, and mismatched controls with the typed reason', () => {
    expect(admit({ hostingSessionId: 'other_lead' })).toEqual({ ok: false, reason: 'foreign_child' });
    expect(admit({ child: { ...reviewerChild, metadata: { ...reviewerChild.metadata, sessionOriginV1: undefined } } })).toEqual({ ok: false, reason: 'foreign_child' });
    expect(admit({ intent: 'delegate' })).toEqual({ ok: false, reason: 'role_mismatch' });
    expect(admit({ busy: true })).toEqual({ ok: false, reason: 'child_busy' });
    const yolo = { ...reviewerChild, metadata: { ...reviewerChild.metadata, permissionMode: 'yolo' } };
    expect(admit({ child: yolo })).toEqual({ ok: false, reason: 'controls_mismatch' });
    const otherModel = { ...reviewerChild, metadata: { ...reviewerChild.metadata, modelOverrideV1: { v: 1, updatedAt: 1, modelId: 'other' } } };
    expect(admit({ child: otherModel })).toEqual({ ok: false, reason: 'controls_mismatch' });
    expect(admit({ controls: resolveVisibleRunControls({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only' }) }))
      .toEqual({ ok: false, reason: 'controls_mismatch' });
  });

  it('accepts the child model when the run leaves the model to the child', () => {
    expect(admit({ controls: resolveVisibleRunControls({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only' }) }))
      .toEqual({ ok: true, childRole: 'reviewer', childAssignmentId: 'a1' });
  });
});

describe('detectVisibleRunControlsChange', () => {
  it('reports a changed permission mode or model from metadata and from recorded message controls', () => {
    expect(detectVisibleRunControlsChange({ controls: reviewControls, metadata: reviewerChild.metadata, userMessageMetas: [{ permissionMode: 'read-only' }] })).toBe(false);
    expect(detectVisibleRunControlsChange({ controls: reviewControls, metadata: { ...reviewerChild.metadata, permissionMode: 'yolo' }, userMessageMetas: [] })).toBe(true);
    expect(detectVisibleRunControlsChange({ controls: reviewControls, metadata: reviewerChild.metadata, userMessageMetas: [{ permissionMode: 'yolo' }] })).toBe(true);
    expect(detectVisibleRunControlsChange({ controls: reviewControls, metadata: reviewerChild.metadata, userMessageMetas: [{ model: 'other' }] })).toBe(true);
  });
});

describe('readVisibleRunTurnOutputs', () => {
  const transcript = [
    { seq: 1, role: 'user' as const, text: 'Earlier unrelated request', localId: 'old', meta: null },
    { seq: 2, role: 'assistant' as const, text: 'Earlier answer', localId: null, meta: null },
    { seq: 3, role: 'user' as const, text: 'Task prompt', localId: 'task_1', meta: { permissionMode: 'read-only' } },
    { seq: 4, role: 'assistant' as const, text: 'Working on it', localId: null, meta: null },
    { seq: 5, role: 'assistant' as const, text: '{"findings":[],"summary":"First"}', localId: null, meta: null },
    { seq: 6, role: 'user' as const, text: 'Steer', localId: 'steer_1', meta: { permissionMode: 'read-only' } },
    { seq: 7, role: 'assistant' as const, text: '{"findings":[],"summary":"Second"}', localId: null, meta: null },
  ];

  it('reads forward from the task message, ignoring earlier messages, one final output per user turn in order', () => {
    expect(readVisibleRunTurnOutputs({ messages: transcript, isTaskMessage: (message) => message.localId === 'task_1' })).toEqual({
      taskFound: true,
      turns: [{ finalText: '{"findings":[],"summary":"First"}' }, { finalText: '{"findings":[],"summary":"Second"}' }],
      userMessageMetas: [{ permissionMode: 'read-only' }, { permissionMode: 'read-only' }],
    });
    expect(readVisibleRunTurnOutputs({ messages: transcript.slice(0, 2), isTaskMessage: (message) => message.localId === 'task_1' }).taskFound).toBe(false);
  });
});
