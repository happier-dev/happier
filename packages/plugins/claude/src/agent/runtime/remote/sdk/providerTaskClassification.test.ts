import { describe, expect, it } from 'vitest';

import {
  classifyClaudeProviderTaskKind,
  isRecordedClaudeProviderTaskKind,
} from './providerTaskClassification.js';

describe('claude provider task kind classification', () => {
  it('classifies a type this build does not recognise as unknown, and still records it', () => {
    // The failure this exists to prevent: a new SDK task type silently becoming an agent row (or
    // nothing at all) because the classifier only knew a fixed list.
    expect(classifyClaudeProviderTaskKind('container_bash')).toBe('unknown');
    expect(isRecordedClaudeProviderTaskKind(classifyClaudeProviderTaskKind('container_bash'))).toBe(true);
  });

  it('separates a shell that outlives its turn from a watch loop', () => {
    for (const taskType of ['local_bash', 'shell']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('command');
    }
    for (const taskType of ['monitor', 'monitor_mcp']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('monitoring');
    }
  });

  it('keeps agent-flavoured work out of the headless record, including local_workflow', () => {
    for (const taskType of ['agent', 'local_agent', 'remote_agent', 'subagent', 'local_workflow', 'remote_workflow', 'workflow']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('agent');
      expect(isRecordedClaudeProviderTaskKind(classifyClaudeProviderTaskKind(taskType))).toBe(false);
    }
  });

  it('treats provider bookkeeping as inert rather than as unrecognised work', () => {
    for (const taskType of ['plan', 'dream']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('inert');
      expect(isRecordedClaudeProviderTaskKind(classifyClaudeProviderTaskKind(taskType))).toBe(false);
    }
  });

  it('reads an untyped task as the generic agent case rather than persisting it as a command', () => {
    for (const taskType of [null, undefined, '', '   ']) {
      expect(classifyClaudeProviderTaskKind(taskType)).toBe('agent');
    }
  });

  it('normalizes provider casing and padding before deciding', () => {
    expect(classifyClaudeProviderTaskKind('  LOCAL_BASH ')).toBe('command');
    expect(classifyClaudeProviderTaskKind('Monitor')).toBe('monitoring');
  });
});
