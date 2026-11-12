import { describe, expect, it } from 'vitest';
import { HappyError } from '@/utils/errors/errors';
import { requireActionSuccess } from './actionResult';

describe('a failed Action envelope', () => {
  it('keeps its request id for the failure presenter', () => {
    let thrown: unknown;
    try {
      requireActionSuccess({ ok: false, errorCode: 'internal_error', error: 'internal_error', requestId: '5b2057fb-request' });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(HappyError);
    expect(thrown).toMatchObject({ code: 'internal_error', requestId: '5b2057fb-request' });
  });
});
