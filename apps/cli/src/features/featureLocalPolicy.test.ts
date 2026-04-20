import { describe, expect, it } from 'vitest';

import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';

describe('resolveCliLocalFeaturePolicyEnabled', () => {
  it('defaults voice.daemonInference to disabled when no local env override is present', () => {
    expect(resolveCliLocalFeaturePolicyEnabled('voice.daemonInference', {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('enables voice.daemonInference when the explicit local env gate is on', () => {
    expect(resolveCliLocalFeaturePolicyEnabled('voice.daemonInference', {
      HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED: '1',
    } as NodeJS.ProcessEnv)).toBe(true);
  });
});
