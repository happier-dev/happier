import { describe, expect, it } from 'vitest';

import { sanitizeSessionStateErrorCode } from './telemetry.js';

describe('sanitizeSessionStateErrorCode', () => {
  it('normalizes safe telemetry codes', () => {
    expect(sanitizeSessionStateErrorCode({ code: ' Provider-Unavailable ' })).toBe('provider_unavailable');
  });

  it('drops unsafe telemetry codes', () => {
    expect(sanitizeSessionStateErrorCode({ code: 'provider failed token=secret' })).toBeUndefined();
  });
});
