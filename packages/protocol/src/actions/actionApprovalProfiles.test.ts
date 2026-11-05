import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';

describe('Account approval profiles at Action admission', () => {
  const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
    approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] },
    approvalProfiles: [{ id: 'custom', name: 'Only reviewed deploys', defaultMode: 'allow',
      actions: { 'deployments.deploy': 'require' } }],
  });

  it('preserves the Account profile collection through normalization', () => {
    expect(normalizeActionsSettingsV1(settings).approvalProfiles).toEqual(settings.approvalProfiles);
    expect(settings.approvalProfiles).toHaveLength(1);
  });
});
