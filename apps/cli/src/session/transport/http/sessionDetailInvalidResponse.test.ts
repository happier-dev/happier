import { describe, expect, it } from 'vitest';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';

import { SessionDetailInvalidResponseError } from './sessionDetailInvalidResponse';

describe('Session detail refusal diagnostics', () => {
  it('retains structural paths through message-only catches without response values or Zod messages', () => {
    const parsed = V2SessionByIdResponseSchema.safeParse({ session: { id: 42 } });
    if (parsed.success) throw new Error('Expected invalid Session detail');
    const error = new SessionDetailInvalidResponseError('v2_session_detail', [
      ...parsed.error.issues,
      { code: 'custom', path: ['session', 'ownerMetadata', 'private-key'], message: 'private-value' },
    ]);
    expect(error.cause).toEqual({ schema: 'v2_session_detail', issues: error.issues });
    expect(error.message).toContain(JSON.stringify({ path: ['session', 'id'], code: 'invalid_type' }));
    expect(error.message).toContain(JSON.stringify({ path: ['session', 'ownerMetadata'], code: 'custom' }));
    expect(JSON.stringify([error.cause, error.message])).not.toContain('private-key');
    expect(JSON.stringify([error.cause, error.message])).not.toContain('private-value');
  });
});
