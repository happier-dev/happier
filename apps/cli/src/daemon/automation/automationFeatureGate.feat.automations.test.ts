import { describe, expect, it } from 'vitest';

import { getAutomationWorkerFeatureDecision, isAutomationWorkerEnabled } from './automationFeatureGate';
import { getWorkflowRuntimeFeatureDecision, isWorkflowRuntimeEnabled } from './workflowFeatureGate';

describe('isAutomationWorkerEnabled', () => {
  it('defaults to enabled when env is unset', () => {
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('supports explicit disabled values', () => {
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0' })).toBe(false);
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'false' })).toBe(false);
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'no' })).toBe(false);
  });

  it('supports explicit enabled values', () => {
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' })).toBe(true);
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'true' })).toBe(true);
    expect(isAutomationWorkerEnabled({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'yes' })).toBe(true);
  });

  it('respects build policy deny list', () => {
    expect(
      isAutomationWorkerEnabled({ NODE_ENV: 'test',
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_BUILD_FEATURES_DENY: 'automations',
      }),
    ).toBe(false);
  });
});

describe('Workflow runtime activation', () => {
  it('fails closed when the server bit is missing or malformed', () => {
    const ready = (features: unknown) => ({ status: 'ready' as const, features: features as never });
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready({ features: { automations: { enabled: true } }, capabilities: {} }))).toBe(false);
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready({ features: { automations: { enabled: true }, workflows: { enabled: 'yes' } }, capabilities: {} }))).toBe(false);
  });

  it('requires the canonical Workflow bit and its Automations dependency', () => {
    const ready = (automations: boolean, workflows: boolean) => ({
      status: 'ready' as const,
      features: { features: { automations: { enabled: automations }, workflows: { enabled: workflows } }, capabilities: {} } as never,
    });
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready(true, true))).toBe(true);
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready(false, true))).toBe(false);
    expect(getWorkflowRuntimeFeatureDecision({ NODE_ENV: 'test' }, ready(false, true)).blockedBy).toBe('dependency');
  });
});

describe('getAutomationWorkerFeatureDecision', () => {
  it('reports build_policy block when denied', () => {
    const decision = getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_BUILD_FEATURES_DENY: 'automations',
    });

    expect(decision.featureId).toBe('automations');
    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('build_policy');
    expect(decision.blockerCode).toBe('build_disabled');
  });
});
