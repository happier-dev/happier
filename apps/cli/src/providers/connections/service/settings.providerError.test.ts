import { describe, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { parseProviderError } from './settings';

describe('parseProviderError', () => {
  it.each([
    ['missing semantic fields', { v: 1, code: 'provider_endpoint_unavailable' }],
    ['unknown code', { v: 1, code: 'made_up', retryable: false, action: 'none' }],
    ['extra field', { ...createProviderErrorV1('provider_endpoint_unavailable'), secret: 'must-not-escape' }],
    ['wrong retryability', { ...createProviderErrorV1('provider_endpoint_unavailable'), retryable: false }],
    ['wrong action', { ...createProviderErrorV1('provider_endpoint_unavailable'), action: 'review_connection' }],
    ['illegal retry delay', { ...createProviderErrorV1('provider_endpoint_unavailable'), retryAfterMs: 5 }],
  ])('rejects %s', (_name, value) => {
    expect(parseProviderError(value)).toBeNull();
  });

  it('returns only canonical parsed data', () => {
    const error = createProviderErrorV1('provider_endpoint_unavailable', {
      connectionId: 'pc_a',
      machineId: 'machine-a',
    });

    expect(parseProviderError(error)).toEqual(error);
  });
});
