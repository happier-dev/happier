import { describe, expect, it } from 'vitest';

import { getAutomationWorkerFeatureDecision } from './automationFeatureGate';
import { getWorkflowRuntimeFeatureDecision, isWorkflowRuntimeEnabled } from './workflowFeatureGate';

describe('Automation worker feature decisions', () => {
  it('defaults to enabled when env is unset', () => {
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test' })).toMatchObject({ state: 'enabled' });
  });

  it('supports explicit disabled values', () => {
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0' })).toMatchObject({ state: 'disabled' });
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'false' })).toMatchObject({ state: 'disabled' });
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'no' })).toMatchObject({ state: 'disabled' });
  });

  it('supports explicit enabled values', () => {
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' })).toMatchObject({ state: 'enabled' });
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'true' })).toMatchObject({ state: 'enabled' });
    expect(getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',  HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'yes' })).toMatchObject({ state: 'enabled' });
  });

  it('uses the canonical Workflow env before its released alias', () => {
    expect(getAutomationWorkerFeatureDecision({ HAPPIER_FEATURE_WORKFLOWS__ENABLED: '0' })).toMatchObject({ state: 'disabled' });
    expect(getAutomationWorkerFeatureDecision({
      HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
    })).toMatchObject({ state: 'enabled' });
    expect(getAutomationWorkerFeatureDecision({
      HAPPIER_FEATURE_WORKFLOWS__ENABLED: '0', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
    })).toMatchObject({ state: 'disabled' });
  });

});

describe('Workflow runtime activation', () => {
  it('fails closed when the server bit is missing or malformed', () => {
    const ready = (features: unknown) => ({ status: 'ready' as const, features: features as never });
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready({ features: { automations: { enabled: true } }, capabilities: {} }))).toBe(false);
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready({ features: { automations: { enabled: true }, workflows: { enabled: 'yes' } }, capabilities: {} }))).toBe(false);
  });

  it('uses the canonical Workflow bit regardless of the released alias value', () => {
    const ready = (automations: boolean, workflows: boolean) => ({
      status: 'ready' as const,
      features: { features: { automations: { enabled: automations }, workflows: { enabled: workflows } }, capabilities: {} } as never,
    });
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready(true, true))).toBe(true);
    expect(isWorkflowRuntimeEnabled({ NODE_ENV: 'test' }, ready(false, true))).toBe(true);
    expect(getWorkflowRuntimeFeatureDecision({ NODE_ENV: 'test' }, ready(true, false)).blockedBy).toBe('server');
  });
});

describe('getAutomationWorkerFeatureDecision', () => {
  it('reports build_policy block when denied', () => {
    const decision = getAutomationWorkerFeatureDecision({ NODE_ENV: 'test',
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_BUILD_FEATURES_DENY: 'automations',
    });

    expect(decision.featureId).toBe('workflows');
    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('build_policy');
    expect(decision.blockerCode).toBe('build_disabled');
  });
});
