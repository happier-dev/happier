import { describe, expect, it } from 'vitest';

import { getSessionStateFieldDescriptor } from './fieldRegistry.js';

describe('SESSION_STATE_FIELD_REGISTRY', () => {
  it('marks provider session id as binding-owned instead of timestamped', () => {
    expect(getSessionStateFieldDescriptor('identity.providerSessionId')).toMatchObject({
      conflictPolicy: 'bindingOwned',
    });
  });

  it('registers runtime work state as a binding-owned runtime field', () => {
    expect(getSessionStateFieldDescriptor('runtime.workState')).toEqual({
      id: 'runtime.workState',
      class: 'runtime',
      conflictPolicy: 'bindingOwned',
      deliveryClass: 'durable_required',
    });
  });

  it('registers usage-limit recovery as a binding-owned runtime field', () => {
    expect(getSessionStateFieldDescriptor('runtime.usageLimitRecovery')).toEqual({
      id: 'runtime.usageLimitRecovery',
      class: 'runtime',
      conflictPolicy: 'bindingOwned',
      deliveryClass: 'durable_required',
    });
  });
});
