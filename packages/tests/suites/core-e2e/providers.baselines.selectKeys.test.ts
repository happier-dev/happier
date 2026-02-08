import { describe, expect, it } from 'vitest';

import { selectBaselineFixtureKeysFromScenario } from '../../src/testkit/providers/baselines';

describe('providers baselines: selectBaselineFixtureKeysFromScenario', () => {
  it('includes all requiredFixtureKeys and selects first observed key from each requiredAny bucket', () => {
    const keys = selectBaselineFixtureKeysFromScenario({
      scenario: {
        requiredFixtureKeys: ['k-required'],
        requiredAnyFixtureKeys: [
          ['k-a', 'k-b'],
          ['k-x', 'k-y'],
        ],
      },
      observedFixtureKeys: ['k-b', 'k-required', 'k-x', 'k-extra'],
    });

    expect(keys).toEqual(['k-b', 'k-required', 'k-x']);
  });

  it('omits requiredAny buckets with no observed key', () => {
    const keys = selectBaselineFixtureKeysFromScenario({
      scenario: {
        requiredFixtureKeys: ['k-required'],
        requiredAnyFixtureKeys: [['k-a', 'k-b']],
      },
      observedFixtureKeys: ['k-required'],
    });

    expect(keys).toEqual(['k-required']);
  });
});

