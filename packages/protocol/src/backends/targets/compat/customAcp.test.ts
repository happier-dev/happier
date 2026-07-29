import { describe, expect, it } from 'vitest';

import {
  hasLegacyCustomAcpConcreteBackendId,
  isLegacyConfiguredAcpFlavorCarrier,
  readLegacyConfiguredAcpBackendId,
} from './customAcp.js';
import { readLegacyContinueWithReplayCompatBackendTargetInput } from './continueWithReplayRpcParamsCompat.js';

describe('customAcp backend-target compat', () => {
  it('reads legacy configured ACP flavor carriers that point at concrete backends', () => {
    expect(readLegacyConfiguredAcpBackendId('acp:review-bot')).toBe('review-bot');
    expect(isLegacyConfiguredAcpFlavorCarrier('acp:review-bot')).toBe(true);
    expect(readLegacyContinueWithReplayCompatBackendTargetInput('acp:review-bot')).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('rejects nested customAcp placeholders inside configured ACP flavor carriers', () => {
    expect(readLegacyConfiguredAcpBackendId('acp:customAcp')).toBeNull();
    expect(isLegacyConfiguredAcpFlavorCarrier('acp:customAcp')).toBe(false);
    expect(hasLegacyCustomAcpConcreteBackendId({ backendId: 'acp:customAcp' })).toBe(true);
    expect(readLegacyContinueWithReplayCompatBackendTargetInput('acp:customAcp')).toBeNull();
  });
});
