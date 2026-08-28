import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import {
  azureEntryWriteMayHaveChangedProviderStateV1,
  azureThreadWriteMayHaveChangedProviderStateV1,
} from './mutations.js';

const FIXTURE = createTriageSourceV1Fixture();

describe('Azure DevOps post-mutation provider semantics', () => {
  it('reconciles the entry outcomes that may follow a provider write, but not preflight refusals', () => {
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'applied', observation: FIXTURE.getResult },
    })).toBe(true);
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'pending', observation: FIXTURE.getResult },
    })).toBe(true);
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'uncertain' },
    })).toBe(true);
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: {
        kind: 'rejected',
        reason: 'fields-ignored',
        observation: FIXTURE.getResult,
      },
    })).toBe(true);
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: {
        kind: 'refused',
        reason: 'entry-not-active',
        observation: FIXTURE.getResult,
      },
    })).toBe(false);
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'unavailable', failure: { class: 'transient', code: 'azure-unreachable' } },
    })).toBe(false);
    expect(azureEntryWriteMayHaveChangedProviderStateV1({
      status: 'error',
      code: 'provider_transport_failed',
      message: 'No Azure result was published.',
      retryable: true,
    })).toBe(false);
  });

  it('keeps Azure thread rejection separate because its successful response may have ignored the write', () => {
    expect(azureThreadWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'rejected', reason: 'fields-ignored', status: 'active' },
    })).toBe(true);
    expect(azureThreadWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'refused', reason: 'already-in-status', status: 'active' },
    })).toBe(false);
  });
});
