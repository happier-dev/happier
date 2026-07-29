import { describe, expect, it } from 'vitest';

import { StopSessionResultSchema } from './stopSessionContract';

describe('StopSessionResultSchema', () => {
  it('distinguishes an accepted stop request from confirmed physical exit', () => {
    expect(StopSessionResultSchema.parse({ status: 'requested' })).toEqual({ status: 'requested' });
    expect(StopSessionResultSchema.parse({ status: 'stopped' })).toEqual({ status: 'stopped' });
  });
});
