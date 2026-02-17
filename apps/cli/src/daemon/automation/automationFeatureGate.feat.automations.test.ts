import { describe, expect, it } from 'vitest';

import { getAutomationWorkerFeatureDecision, isAutomationWorkerEnabled } from './automationFeatureGate';

describe('isAutomationWorkerEnabled', () => {
  it('defaults to enabled when env is unset', () => {
    expect(isAutomationWorkerEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('supports explicit disabled values', () => {
    expect(isAutomationWorkerEnabled({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutomationWorkerEnabled({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutomationWorkerEnabled({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'no' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('supports explicit enabled values', () => {
    expect(isAutomationWorkerEnabled({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAutomationWorkerEnabled({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAutomationWorkerEnabled({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('respects build policy deny list', () => {
    expect(
      isAutomationWorkerEnabled({
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_BUILD_FEATURES_DENY: 'automations',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe('getAutomationWorkerFeatureDecision', () => {
  it('reports build_policy block when denied', () => {
    const decision = getAutomationWorkerFeatureDecision({
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_BUILD_FEATURES_DENY: 'automations',
    } as NodeJS.ProcessEnv);

    expect(decision.featureId).toBe('automations');
    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('build_policy');
    expect(decision.blockerCode).toBe('build_disabled');
  });
});
