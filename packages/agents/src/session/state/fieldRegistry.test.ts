import { describe, expect, it } from 'vitest';

import { getSessionStateFieldDescriptor } from './fieldRegistry.js';

describe('SESSION_STATE_FIELD_REGISTRY', () => {
  it('marks vendor session id as binding-owned instead of timestamped', () => {
    expect(getSessionStateFieldDescriptor('identity.vendorSessionId')).toMatchObject({
      conflictPolicy: 'bindingOwned',
    });
  });
});
