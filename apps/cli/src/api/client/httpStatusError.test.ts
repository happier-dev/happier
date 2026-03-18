import { describe, expect, it } from 'vitest';

import { HttpStatusError, readHttpStatus } from './httpStatusError';

describe('HttpStatusError', () => {
  it('stores the status on a minimal response shape', () => {
    const error = new HttpStatusError(503, 'service unavailable');

    expect(error.name).toBe('HttpStatusError');
    expect(error.message).toBe('service unavailable');
    expect(error.response.status).toBe(503);
    expect(readHttpStatus(error)).toBe(503);
  });

  it('returns null for non-status errors', () => {
    expect(readHttpStatus(null)).toBeNull();
    expect(readHttpStatus({ response: {} })).toBeNull();
  });
});
