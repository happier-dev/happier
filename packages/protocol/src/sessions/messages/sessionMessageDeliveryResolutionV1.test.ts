import { describe, expect, it } from 'vitest';

import {
  parseSessionMessageDeliveryResolutionV1,
  SessionMessageDeliveryResolutionV1Schema,
} from './sessionMessageDeliveryResolutionV1.js';

describe('SessionMessageDeliveryResolutionV1', () => {
  it('accepts only the minimal manual-handled provenance', () => {
    expect(SessionMessageDeliveryResolutionV1Schema.parse({ v: 1, kind: 'manual_handled' })).toEqual({
      v: 1,
      kind: 'manual_handled',
    });
    expect(parseSessionMessageDeliveryResolutionV1({ v: 1, kind: 'provider_accepted' })).toBeNull();
    expect(parseSessionMessageDeliveryResolutionV1({ v: 1, kind: 'manual_handled', receipt: 'extra' })).toBeNull();
  });
});
