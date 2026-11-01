import { describe, expect, it } from 'vitest';

import { SessionPermissionResponseToOccurrenceV1Schema } from './sessionPermissionResponse.js';

describe('occurrence-bound permission responses', () => {
  it('preserves the existing rich permission decision payload', () => {
    const response = {
      id: 'tool-call',
      occurrenceId: 'current-occurrence',
      approved: true,
      decision: 'approved_execpolicy_amendment',
      reason: 'Allow the selected command',
      mode: 'read-only',
      allowedTools: ['Read'],
      allowTools: ['Read'],
      execPolicyAmendment: { command: ['git', 'status'] },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Read' }] }],
      answers: { Choice: 'first' },
      structuredAnswersV1: { Choice: ['first'] },
      receivedAt: 42,
    };

    expect(SessionPermissionResponseToOccurrenceV1Schema.parse(response)).toEqual(response);
  });

  it('requires the occurrence at the receiver-enforced method boundary', () => {
    expect(SessionPermissionResponseToOccurrenceV1Schema.safeParse({ id: 'tool-call', approved: false }).success).toBe(false);
    expect(SessionPermissionResponseToOccurrenceV1Schema.safeParse({ id: 'tool-call', occurrenceId: ' ', approved: false }).success).toBe(false);
  });
});
