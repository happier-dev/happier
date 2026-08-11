import { describe, expect, it } from 'vitest';

import {
  classifyClaudeProviderTaskKind,
  isRecordedClaudeProviderTaskKind,
  resolveClaudeProviderTaskAdmission,
  type ClaudeProviderTaskKind,
} from './claudeProviderTaskClassification';

describe('Claude provider task classification', () => {
  it('separates liveness admission from presentation kind', () => {
    // PLAN 8.4: `admission` and `kind` are separate fields with separate rules, and no change may
    // make one decide both. `local_workflow` is the proof - agent-flavoured for presentation,
    // detached work for liveness - so any implementation that derives one from the other fails
    // here rather than at a user-visible surface.
    expect(resolveClaudeProviderTaskAdmission('local_workflow')).toBe('admit');
    expect(classifyClaudeProviderTaskKind('local_workflow')).toBe('agent');

    expect(resolveClaudeProviderTaskAdmission('subagent')).toBe('known-only');
    expect(classifyClaudeProviderTaskKind('subagent')).toBe('agent');

    expect(resolveClaudeProviderTaskAdmission('local_bash')).toBe('admit');
    expect(classifyClaudeProviderTaskKind('local_bash')).toBe('command');
  });

  it('admits every unrecognised typed task rather than dropping it', () => {
    // The denylist, vindicated by t3code's production bug in the mirror direction: an allowlist
    // silently stops counting work whose type name it has never seen.
    for (const taskType of ['shell', 'container_bash', 'sandbox_exec', 'future_thing']) {
      expect(resolveClaudeProviderTaskAdmission(taskType)).toBe('admit');
    }
    for (const taskType of ['agent', 'local_agent', 'remote_agent', 'subagent']) {
      expect(resolveClaudeProviderTaskAdmission(taskType)).toBe('known-only');
    }
    for (const absent of [null, undefined, '', '   ']) {
      expect(resolveClaudeProviderTaskAdmission(absent)).toBe('known-only');
    }
  });

  it('recognises monitors so they are classified rather than silently dropped', () => {
    // PLAN 4.9.2: recognise the vocabulary now; ship no monitor kind, row action or stop
    // affordance until a producer exists. Recognition alone is what keeps a future `monitor` from
    // falling through as an anonymous unknown.
    for (const taskType of ['monitor', 'monitor_mcp']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('monitoring');
    }
    // Background shells are commands, not watch loops. t3code groups all four for LIVENESS - which
    // is the axis admission uses, and all four admit - but a persisted row must still say which of
    // the two it is.
    for (const taskType of ['local_bash', 'shell']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('command');
    }
    for (const taskType of ['monitor', 'monitor_mcp', 'local_bash', 'shell']) {
      expect(resolveClaudeProviderTaskAdmission(taskType)).toBe('admit');
    }
  });

  it('keeps bookkeeping types out of both liveness and durable history', () => {
    for (const taskType of ['plan', 'dream']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('inert');
      expect(resolveClaudeProviderTaskAdmission(taskType)).toBe('known-only');
      expect(isRecordedClaudeProviderTaskKind(classifyClaudeProviderTaskKind(taskType))).toBe(false);
    }
  });

  it('records only headless work, never agent-flavoured or inert work', () => {
    const recorded: Record<ClaudeProviderTaskKind, boolean> = {
      agent: false,
      inert: false,
      command: true,
      monitoring: true,
      unknown: true,
    };
    for (const [kind, expected] of Object.entries(recorded)) {
      expect(isRecordedClaudeProviderTaskKind(kind as ClaudeProviderTaskKind)).toBe(expected);
    }
    // An untyped task is the generic Task/Agent case: it never becomes a headless command row.
    expect(classifyClaudeProviderTaskKind(null)).toBe('agent');
    expect(classifyClaudeProviderTaskKind('future_thing')).toBe('unknown');
  });

  it('normalises provider casing and padding before classifying', () => {
    expect(classifyClaudeProviderTaskKind('  Local_Bash  ')).toBe('command');
    expect(resolveClaudeProviderTaskAdmission(' SUBAGENT ')).toBe('known-only');
  });
});
