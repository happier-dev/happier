import { describe, expect, it } from 'vitest';

import { resolveUnsupportedSwitchContinuityErrorCode } from './resolveUnsupportedSwitchContinuityErrorCode';

describe('resolveUnsupportedSwitchContinuityErrorCode', () => {
  it('preserves true unsupported-service continuity reasons', () => {
    expect(resolveUnsupportedSwitchContinuityErrorCode('unsupported_service')).toBe('unsupported_service');
  });

  it('preserves specific continuity failure reasons', () => {
    expect(resolveUnsupportedSwitchContinuityErrorCode('provider_state_sharing_required'))
      .toBe('provider_state_sharing_required');
    expect(resolveUnsupportedSwitchContinuityErrorCode('provider_state_sharing_unavailable'))
      .toBe('provider_state_sharing_unavailable');
    expect(resolveUnsupportedSwitchContinuityErrorCode('provider_state_sharing_settings_unavailable'))
      .toBe('provider_state_sharing_settings_unavailable');
    expect(resolveUnsupportedSwitchContinuityErrorCode('provider_session_state_unavailable_for_resume'))
      .toBe('provider_session_state_unavailable_for_resume');
  });

  it('maps unknown continuity miss reasons to a phase-specific unsupported-continuity code', () => {
    expect(resolveUnsupportedSwitchContinuityErrorCode('app_server_hot_apply_failed')).toBe('continuity_unsupported');
    expect(resolveUnsupportedSwitchContinuityErrorCode('provider_proof_unavailable')).toBe('continuity_unsupported');
    expect(resolveUnsupportedSwitchContinuityErrorCode(null)).toBe('continuity_unsupported');
  });
});
