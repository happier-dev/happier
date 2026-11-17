import { describe, expect, it } from 'vitest';
import { isAgentStartActionInvocationV1, projectActionWorkflowSelectionInputV1, resolveActionAgentStartRequestsV1 } from './agentStartAdmission.js';

const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } };
const engineId = 'agent:native.agent/agent';
const baseline = { machineId: 'machine', directory: '/repo' };

describe('Review roster Agent admission', () => {
  it('retains deferred historical item targets for concrete Workflow admission', () => {
    expect(resolveActionAgentStartRequestsV1({ actionId: 'review.start',
      input: { engineIds: [{ kind: 'unresolved' }, engineId] }, context: {}, baseline,
    })).toMatchObject({ ok: false, errorCode: 'target_unavailable',
      knownFacts: { agentTarget: { kind: 'unresolved' } },
      knownRequests: [{ kind: 'execution_run', source: 'review', facts: { agentTarget } }],
    });
  });
  it('decodes historical engine overrides before Workflow defaults without replacing an authored canonical roster', () => {
    const historical = { engineIds: [engineId], engines: { [engineId]: { focus: 'historical-options' } },
      modelId: 'historical-model', connectedServicesByBackendTargetKey: { [engineId]: null } };
    const selected = { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'another.agent', localId: 'other' } } };
    const reviewers = [{ kind: 'engine', engineId, modelId: 'historical-model',
      options: { focus: 'historical-options' }, connectedServices: null }];
    expect(projectActionWorkflowSelectionInputV1('review.start', historical, selected)).toMatchObject({ reviewers });
    expect(resolveActionAgentStartRequestsV1({ actionId: 'review.start', input: historical,
      context: {}, baseline, effectiveSelection: { selection: selected },
    })).toMatchObject({ ok: true, effectiveInput: { reviewers }, requests: [{ facts: {
      agentTarget, modelSelection: { modelId: 'historical-model' }, connectedServices: null,
    } }] });
    const canonical = [{ kind: 'engine', engineId, modelId: 'authored-model' }];
    expect(projectActionWorkflowSelectionInputV1('review.start', { ...historical, reviewers: canonical }, selected))
      .toMatchObject({ reviewers: canonical });
  });

  it('classifies human-only Reviews without requiring Agent depth or context while retaining authored executable steps', () => {
    const reviewers = [{ kind: 'person', principal: { kind: 'account', accountId: 'person' }, required: true }];
    expect(isAgentStartActionInvocationV1('review.start', { reviewers })).toBe(false);
    expect(isAgentStartActionInvocationV1('review.start', { reviewers, steps: [
      { kind: 'review', instructions: 'Review', reviewers },
    ] })).toBe(false);
    expect(isAgentStartActionInvocationV1('review.start', { reviewers, steps: [
      { kind: 'review', instructions: 'Review', reviewers: [{ kind: 'engine', engineId }] },
    ] })).toBe(true);
    expect(isAgentStartActionInvocationV1('review.start', { reviewers: [{ kind: 'session', session: { serverId: 'home', sessionId: 'reviewer' } }] })).toBe(true);
  });

  it('preserves ordered mixed selections and independent models and credentials for the same engine', () => {
    const connectedServices = { v: 2, bindingsByServiceId: {} };
    const teamCredentialModel = { kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'resource',
      expectedResourceRevision: 2, deliveryMode: 'direct', agentTargetKey: engineId, modelId: 'second-model' };
    const teamCredentialSessionBindingConsent = { v: 1, sessionId: 'origin', teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2 };
    const reviewers = [
      { kind: 'engine', engineId, modelId: 'first-model', launchProfileId: 'first-profile', connectedServices },
      { kind: 'person', principal: { kind: 'account', accountId: 'person' }, required: true },
      { kind: 'session', session: { serverId: 'home', sessionId: 'reviewer-session' } },
      { kind: 'engine', engineId, teamCredentialModel, teamCredentialSessionBindingConsent,
        launchProfileId: 'second-profile', connectedServices: null },
      { kind: 'model', launch: { executionTarget: { serverId: 'home', machineId: 'other-machine' },
        directory: { kind: 'path', path: '/other' }, agentTarget,
        modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: engineId, providerConnectionId: null, modelId: 'fresh-model' } } } },
    ];
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'review.start',
      input: { reviewers, instructions: 'Review', modelId: 'global-model' }, context: {}, baseline,
      effectiveSelection: { selection: { agentTarget, profileId: 'workflow-profile' } },
    });
    expect(resolved).toMatchObject({ ok: true, requests: [
      { kind: 'execution_run', source: 'review', intent: 'review', facts: {
        modelSelection: { modelId: 'first-model' }, profileId: 'first-profile', connectedServices,
      } },
      { kind: 'session_target', targetSessionId: 'reviewer-session' },
      { kind: 'execution_run', source: 'review', facts: {
        modelSelection: { modelId: 'second-model' }, profileId: 'second-profile', connectedServices: null,
      } },
      { kind: 'spawn_new', facts: { machineId: 'other-machine', directory: '/other', modelSelection: { ref: { modelId: 'fresh-model' } } } },
    ] });
    if (!resolved.ok) throw new Error(resolved.errorCode);
    expect(resolved.effectiveInput.reviewers).toMatchObject(reviewers);
  });

  it('projects a Workflow target as an engine selection and admits a people-only roster without Agent work', () => {
    expect(projectActionWorkflowSelectionInputV1('review.start', {}, { agentTarget }))
      .toMatchObject({ reviewers: [{ kind: 'engine', engineId }] });
    const reviewers = [{ kind: 'person', principal: { kind: 'account', accountId: 'person' }, required: false }];
    expect(resolveActionAgentStartRequestsV1({ actionId: 'review.start', input: { reviewers }, context: {}, baseline }))
      .toEqual({ ok: true, effectiveInput: { reviewers }, requests: [] });
  });

  it.each([false, true])('inherits Workflow configuration while preserving an explicit reviewer model: override=%s', overrideEngine => {
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'review.start', input: {
      reviewers: [{ kind: 'engine', engineId, modelId: 'reviewer-model' }],
    }, context: {}, baseline, effectiveSelection: { overrideEngine, selection: { agentTarget,
      modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: engineId, providerConnectionId: null, modelId: 'workflow-model' } },
      profileId: 'workflow-profile', connectedServices: null,
    } } });
    expect(resolved).toMatchObject({ ok: true, requests: [{ facts: {
      modelSelection: { modelId: 'reviewer-model' }, profileId: 'workflow-profile', connectedServices: null,
    } }], effectiveInput: { reviewers: [{ kind: 'engine', engineId, modelId: 'reviewer-model', launchProfileId: 'workflow-profile', connectedServices: null }] } });
  });
});
