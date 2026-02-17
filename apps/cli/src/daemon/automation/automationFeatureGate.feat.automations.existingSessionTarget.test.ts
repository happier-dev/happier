import { describe, expect, it } from 'vitest';

import { isExistingSessionAutomationTargetEnabled } from './automationFeatureGate';

describe('isExistingSessionAutomationTargetEnabled', () => {
  it('defaults to disabled when env is unset', () => {
    expect(isExistingSessionAutomationTargetEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('supports explicit disabled values', () => {
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '0',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: 'false',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: 'off',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('supports explicit enabled values', () => {
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'true',
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'yes',
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: 'on',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('respects build policy deny list for existing-session-target feature', () => {
    expect(
      isExistingSessionAutomationTargetEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        HAPPIER_BUILD_FEATURES_DENY: 'automations.existingSessionTarget',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

