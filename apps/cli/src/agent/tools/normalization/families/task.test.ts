import { describe, expect, it } from 'vitest';

import { normalizeTaskInput, normalizeTaskResult } from './task';

describe('normalizeTaskInput', () => {
  it('infers create operation from TaskCreate tool names', () => {
    const normalized = normalizeTaskInput('TaskCreate', { subject: 'Do thing' });
    expect(normalized).toMatchObject({ operation: 'create', subject: 'Do thing' });
  });

  it('falls back to unknown operation for non-task tool names with primitive input', () => {
    const normalized = normalizeTaskInput('custom_tool', 123);
    expect(normalized).toEqual({ operation: 'unknown', value: 123 });
  });
});

describe('normalizeTaskResult', () => {
  it('strips <task_metadata> blocks from string output', () => {
    const normalized = normalizeTaskResult('hello\n<task_metadata>\nsecret\n</task_metadata>\nworld');
    expect(normalized).toEqual({ content: 'hello\n\nworld' });
    expect(normalized).not.toHaveProperty('_raw');
  });

  it('returns empty object when metadata-only blocks normalize to empty text', () => {
    const normalized = normalizeTaskResult('<task_metadata>\nsecret\n</task_metadata>');
    expect(normalized).toEqual({});
  });

  it('normalizes output wrappers and preserves side fields', () => {
    const normalized = normalizeTaskResult({
      output: 'result\n<task_metadata>\nsecret\n</task_metadata>',
      status: 'ok',
    });
    expect(normalized).toMatchObject({ content: 'result', status: 'ok' });
  });
});
