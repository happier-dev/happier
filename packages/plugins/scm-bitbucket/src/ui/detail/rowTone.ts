import { isBitbucketFailingBuildStateV1, type BitbucketProjectedStatusRowV1 } from '../../triage/detail/projection.js';

/** The tone a Builds panel row draws for Bitbucket's own state of that build. */
export function bitbucketBuildToneV1(row: Pick<BitbucketProjectedStatusRowV1, 'state'>): 'danger' | 'neutral' {
  // Healthy says nothing and running is not a caution: only a failure (the rollup's own rule) colours the row.
  return isBitbucketFailingBuildStateV1(row.state) ? 'danger' : 'neutral';
}
