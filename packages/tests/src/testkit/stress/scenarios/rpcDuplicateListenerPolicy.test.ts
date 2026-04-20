import { describe, expect, it } from 'vitest';

import {
  buildRpcDuplicateListenerScopeCases,
  classifyRpcDuplicateListenerOutcome,
} from './rpcDuplicateListenerPolicy';

describe('rpcDuplicateListenerPolicy', () => {
  it('builds representative user, session, and machine scoped methods', () => {
    expect(
      buildRpcDuplicateListenerScopeCases({
        sessionId: 'sess_1',
        machineId: 'machine_1',
      }),
    ).toEqual([
      {
        scope: 'user',
        method: 'stress.duplicate-policy.user',
      },
      {
        scope: 'session',
        method: 'sess_1:stress.duplicate-policy.session',
      },
      {
        scope: 'machine',
        method: 'machine_1:stress.duplicate-policy.machine',
      },
    ]);
  });

  it('classifies rejected duplicates before responder inspection', () => {
    expect(
      classifyRpcDuplicateListenerOutcome({
        secondRegistrationRejected: true,
        responderIds: new Set(['listener-a', 'listener-b']),
      }),
    ).toBe('rejected');
  });

  it('classifies a single responder set as deterministic', () => {
    expect(
      classifyRpcDuplicateListenerOutcome({
        secondRegistrationRejected: false,
        responderIds: new Set(['listener-a']),
      }),
    ).toBe('deterministic');
  });

  it('classifies multi-responder churn as ambiguous', () => {
    expect(
      classifyRpcDuplicateListenerOutcome({
        secondRegistrationRejected: false,
        responderIds: new Set(['listener-a', 'listener-b']),
      }),
    ).toBe('ambiguous');
  });
});
