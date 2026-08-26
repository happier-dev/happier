import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import {
  bitbucketCommentWriteMayHaveChangedProviderStateV1,
  bitbucketEntryWriteMayHaveChangedProviderStateV1,
} from './mutations.js';

const FIXTURE = createTriageSourceV1Fixture();

describe('Bitbucket post-mutation provider semantics', () => {
  it('reconciles uncertain entry writes, but not the documented provider rejection', () => {
    expect(bitbucketEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'applied', observation: FIXTURE.getResult },
    })).toBe(true);
    expect(bitbucketEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'pending', observation: FIXTURE.getResult },
    })).toBe(true);
    expect(bitbucketEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'uncertain' },
    })).toBe(true);
    expect(bitbucketEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: {
        kind: 'rejected',
        reason: 'provider-rejected',
        failure: { class: 'unknown', code: '409' },
      },
    })).toBe(false);
    expect(bitbucketEntryWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'unavailable', failure: { class: 'transient', code: 'bitbucket-unreachable' } },
    })).toBe(false);
    expect(bitbucketEntryWriteMayHaveChangedProviderStateV1({
      status: 'error',
      code: 'provider_transport_failed',
      message: 'No Bitbucket result was published.',
      retryable: true,
    })).toBe(false);
  });

  it('reconciles an unconfirmed comment resolution after Bitbucket accepted its request', () => {
    expect(bitbucketCommentWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'rejected', reason: 'resolution-unconfirmed', resolution: 'unresolved' },
    })).toBe(true);
    expect(bitbucketCommentWriteMayHaveChangedProviderStateV1({
      status: 'success',
      result: { kind: 'refused', reason: 'already-in-resolution', resolution: 'resolved' },
    })).toBe(false);
  });
});
