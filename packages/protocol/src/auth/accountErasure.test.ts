import { describe, expect, it } from 'vitest';
import { AccountErasureRequestV1Schema } from './accountErasure.js';
describe('AccountErasureRequestV1Schema', () => {
  it('accepts only exact confirmation and no Account selector', () => {
    expect(AccountErasureRequestV1Schema.parse({ confirmation: 'DELETE' })).toEqual({ confirmation: 'DELETE' });
    expect(AccountErasureRequestV1Schema.safeParse({ confirmation: 'delete' }).success).toBe(false);
    expect(AccountErasureRequestV1Schema.safeParse({ confirmation: 'DELETE', accountId: 'other' }).success).toBe(false);
  });
});
