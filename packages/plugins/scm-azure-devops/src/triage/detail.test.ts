import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { projectAzureDetailOverview } from './detail.js';

describe('the admitted Azure detail review revision', () => {
  const { detailInput } = createTriageSourceV1Fixture();

  it('retains the merge source when public Triage strips process-local fold evidence', () => {
    const { nativeRevision: _foldRevision, ...observation } = detailInput.observation;
    expect(projectAzureDetailOverview({ ...detailInput, observation }).nativeRevision)
      .toBe(observation.snapshot.reviewRevision?.nativeRevision);
  });

  it('withholds the merge source when the admitted review snapshot has none', () => {
    const { reviewRevision: _revision, ...snapshot } = detailInput.observation.snapshot;
    expect(projectAzureDetailOverview({
      ...detailInput,
      observation: { ...detailInput.observation, snapshot },
    }).nativeRevision).toBeNull();
  });
});
