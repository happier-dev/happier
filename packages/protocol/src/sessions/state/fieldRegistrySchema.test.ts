import { describe, expect, it } from 'vitest';

import { SessionStateFieldDescriptorSchema } from './fieldRegistrySchema.js';

describe('SessionStateFieldDescriptorSchema', () => {
  it('requires delivery class on registered field descriptors', () => {
    expect(SessionStateFieldDescriptorSchema.safeParse({
      id: 'runtime.workState',
      class: 'runtime',
      deliveryClass: 'durable_required',
    }).success).toBe(true);

    expect(SessionStateFieldDescriptorSchema.safeParse({
      id: 'runtime.workState',
      class: 'runtime',
    }).success).toBe(false);
  });
});
