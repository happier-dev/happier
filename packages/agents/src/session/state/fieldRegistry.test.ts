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

  it('registers runtime activity as a binding-owned runtime projection', () => {
    expect(getSessionStateFieldDescriptor('runtime.activity')).toEqual({
      id: 'runtime.activity',
      class: 'runtime',
      conflictPolicy: 'bindingOwned',
      deliveryClass: 'durable_best_effort',
    });
  });

  it('registers external-Agent observations as a distinct host-owned durable projection', () => {
    expect(getSessionStateFieldDescriptor('runtime.externalAgent')).toEqual({
      id: 'runtime.externalAgent',
      class: 'runtime',
      conflictPolicy: 'bindingOwned',
      deliveryClass: 'durable_best_effort',
    });
  });

  it('registers current external-session operation progress as durable descriptive state', () => {
    expect(getSessionStateFieldDescriptor('runtime.externalSessionOperation')).toEqual({
      id: 'runtime.externalSessionOperation',
      class: 'runtime',
      conflictPolicy: 'bindingOwned',
      deliveryClass: 'durable_required',
    });
  });
});
