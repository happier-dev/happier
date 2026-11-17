import { describe, expect, it } from 'vitest';
import { executeSessionDelete } from './delete.js';
import type { ActionExecuteResult } from '../types.js';

describe('Session delete result ownership', () => {
  it.each([
    { ok: true, result: { success: true } },
    { ok: false, errorCode: 'session_delete_conflict', error: 'session_delete_conflict' },
  ] satisfies ActionExecuteResult[])('preserves the Home fallback result without another envelope: $ok', async expected => {
    const result = await executeSessionDelete({
      input: { sessionId: 'imported-history' }, context: { surface: 'ui' },
      deps: {
        homeDomainAction: async () => expected.ok ? expected.result : expected,
        sessionDelete: ({ deleteFromHome }) => deleteFromHome(),
      },
      isDeferredApprovalResult: () => false,
    });
    expect(result).toEqual(expected);
  });

  it('projects the native transport payload into one Action result', async () => {
    const result = await executeSessionDelete({
      input: { sessionId: 'native-history' }, context: { surface: 'ui' },
      deps: { homeDomainAction: async () => { throw new Error('Native receiver owns Home deletion'); },
        sessionDelete: async () => ({ success: true }) },
      isDeferredApprovalResult: () => false,
    });
    expect(result).toEqual({ ok: true, result: { success: true } });
  });
});
