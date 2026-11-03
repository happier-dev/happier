import { describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { evaluateFeatureBuildPolicy } from '@happier-dev/protocol/features/buildPolicy';
import { resolveFeatureBuildPolicyFromEnvOrEmbedded } from '@happier-dev/protocol/features/embeddedFeaturePolicy';
import { readCliFeatureBuildPolicyInputs } from './featureBuildPolicy';

describe('organization feature deny input', () => {
  it('keeps policy denial when process env attempts to allow the feature', () => {
    const result = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","features":{"deny":["voice"]}}');
    const inputs = readCliFeatureBuildPolicyInputs({ HAPPIER_BUILD_FEATURES_ALLOW: 'voice' }, result);
    expect(evaluateFeatureBuildPolicy(resolveFeatureBuildPolicyFromEnvOrEmbedded(inputs), 'voice')).toBe('deny');
    expect(evaluateFeatureBuildPolicy(resolveFeatureBuildPolicyFromEnvOrEmbedded(readCliFeatureBuildPolicyInputs({}, { status: 'absent' })), 'voice')).toBe('neutral');
  });
});
