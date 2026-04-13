import { describe, expect, it } from 'vitest';

import { isConfiguredAcpProbeTarget } from './isConfiguredAcpProbeTarget';

describe('isConfiguredAcpProbeTarget', () => {
  it('treats configured ACP backend targets as configured even when the agentId is not customAcp', () => {
    expect(
      isConfiguredAcpProbeTarget({
        agentId: 'claude',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      }),
    ).toBe(true);
  });
});
