import { describe, expect, it } from 'vitest';

import {
  buildProviderInputGenerationEpochId,
} from './providerInputGenerationAdmission';

describe('provider input generation admission', () => {
  it('includes the exact desired adoption tuple in the epoch identity', () => {
    const common = {
      runtimeIdentityKey: 'runtime-a',
      targetRevision: 7,
      serviceId: 'openai-codex',
      groupId: 'primary',
    };
    const first = buildProviderInputGenerationEpochId({
      ...common,
      desired: { profileId: 'one', generation: 3, credentialRevision: 'csr_one' },
    });
    const second = buildProviderInputGenerationEpochId({
      ...common,
      desired: { profileId: 'two', generation: 4, credentialRevision: 'csr_two' },
    });

    expect(first).not.toBe(second);
  });
});
