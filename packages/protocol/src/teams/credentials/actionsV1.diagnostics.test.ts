import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { TeamCredentialTestActionOutputV1Schema } from './actionsV1.js';

describe('Team credential Test diagnostics', () => {
  const previousReply = {
    result: 'needs_attention',
    readiness: { kind: 'source_unavailable' },
    code: 'upstream_unavailable',
  };

  it('accepts an older server reply with diagnostic fields absent', () => {
    expect(TeamCredentialTestActionOutputV1Schema.parse(previousReply)).toEqual(previousReply);
  });

  it('documents that an older strict client rejects added diagnostic fields', () => {
    // The previous closed output shape had these four fields and no diagnostics.
    const { result, readiness, code, recovery } = TeamCredentialTestActionOutputV1Schema.shape;
    const previousClientOutput = z.strictObject({ result, readiness, code, recovery });
    expect(previousClientOutput.safeParse(previousReply).success).toBe(true);
    expect(previousClientOutput.safeParse({ ...previousReply, requestId: 'broker-request-1106' }).success).toBe(false);
  });

  it('retains only closed failure detail alongside the optional request ID', () => {
    const reply = { ...previousReply, requestId: 'broker-request-1106',
      failureDetail: { code: 'source_invalid', stage: 'application_response', httpStatus: 403 } };
    expect(TeamCredentialTestActionOutputV1Schema.parse(reply)).toEqual(reply);
    for (const failureDetail of [
      { ...reply.failureDetail, code: 'private vendor text' },
      { ...reply.failureDetail, stage: 'private vendor text' },
      { ...reply.failureDetail, headers: { authorization: 'private fixture value' } },
    ]) expect(TeamCredentialTestActionOutputV1Schema.safeParse({ ...reply, failureDetail }).success).toBe(false);
  });
});
