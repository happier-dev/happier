import { describe, expect, it } from 'vitest';

import { resolveSwitchUxDiagnosticSource } from './resolveSwitchUxDiagnosticSource';

describe('resolveSwitchUxDiagnosticSource', () => {
  it('maps manual, runtime-auth, and usage-limit switch reasons to distinct diagnostic sources', () => {
    expect(resolveSwitchUxDiagnosticSource('manual')).toBe('manual_auth_switch');
    expect(resolveSwitchUxDiagnosticSource(undefined)).toBe('manual_auth_switch');
    expect(resolveSwitchUxDiagnosticSource('automatic_runtime_failure')).toBe('runtime_auth_recovery');
    expect(resolveSwitchUxDiagnosticSource('pre_turn_group_policy')).toBe('usage_limit_recovery');
  });
});
