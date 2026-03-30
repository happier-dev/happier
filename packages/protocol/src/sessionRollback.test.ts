import { describe, expect, it } from 'vitest';

import { SessionRollbackTargetSchema } from './sessionRollback.js';

describe('sessionRollback', () => {
  it('parses latest_turn rollback targets', () => {
    expect(SessionRollbackTargetSchema.parse({ type: 'latest_turn' })).toEqual({ type: 'latest_turn' });
  });

  it('parses before_user_message rollback targets', () => {
    expect(
      SessionRollbackTargetSchema.parse({
        type: 'before_user_message',
        userMessageSeq: 7,
      }),
    ).toEqual({
      type: 'before_user_message',
      userMessageSeq: 7,
    });
  });

  it('rejects invalid before_user_message targets', () => {
    expect(() => SessionRollbackTargetSchema.parse({ type: 'before_user_message', userMessageSeq: -1 })).toThrow();
  });

  it('rejects provider-specific rollback parameters on semantic targets', () => {
    expect(() => SessionRollbackTargetSchema.parse({ type: 'before_user_message', userMessageSeq: 7, numTurns: 2 })).toThrow();
  });
});
