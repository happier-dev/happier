import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { projectAzureDetailOverview } from './detail.js';

describe('the admitted Azure detail review revision', () => {
  const { detailInput } = createTriageSourceV1Fixture();

  it('names tags in observations that carry only the native fact id', () => {
    const observation = { ...detailInput.observation, snapshot: {
      ...detailInput.observation.snapshot,
      facts: [{ id: 'azure-devops/tags', importance: 'secondary', value: { kind: 'text', value: 'infrastructure' } }],
    } } satisfies typeof detailInput.observation;
    expect(projectAzureDetailOverview({ ...detailInput, observation }).fields).toEqual([
      { kind: 'text', id: 'azure-devops/tags', label: 'Tags', value: 'infrastructure' },
    ]);
  });

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
