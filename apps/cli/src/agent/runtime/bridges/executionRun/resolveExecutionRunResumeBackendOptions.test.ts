import { describe, expect, it } from 'vitest';

import {
  buildBackendTargetKeyV2,
  ProviderBoundModelRefSchema,
  type ConnectedServiceBindingsV2,
} from '@happier-dev/protocol';

import type { ExecutionRunState } from './executionRunTypes';
import { resolveExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';
import { projectRetainedExecutionRunState, RetainedExecutionRunRecordSchema } from './retainedState';

const CONNECTED_SELECTION: ConnectedServiceBindingsV2 = {
  v: 2,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
  },
};

const OVERRIDES = {
  v: 1 as const,
  updatedAt: 1,
  overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
};

const MODEL_SELECTION = ProviderBoundModelRefSchema.parse({
  agentTargetKey: 'agent:happier.agent.codex/codex',
  providerConnectionId: 'pc_openai',
  modelId: 'gpt-5.5',
});

function baseRun(launch: ExecutionRunState['launch']): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sc_1',
    sessionId: 'sess_1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'cancelled',
    startedAtMs: 1,
    ...(launch ? { launch } : {}),
  };
}

describe('resolveExecutionRunResumeBackendOptions', () => {
  it.each([{
      outputs: ['walkthrough' as const], narrator: { engineId: 'claude', modelId: 'narration-model' },
    }, null])('restores the original Review output choice after host recovery: %j', reviewOutputSelection => {
    const run = { ...baseRun(undefined), intent: 'review' as const,
      launch: { cwd: '/repo', reviewOutputSelection } };
    const recovered = RetainedExecutionRunRecordSchema.parse(JSON.parse(JSON.stringify({
      ownerPid: 123, state: projectRetainedExecutionRunState(run),
    }))).state;

    expect(resolveExecutionRunResumeBackendOptions({ run: recovered }).start).toMatchObject({
      reviewOutputSelection,
    });
    expect(recovered.intentInput).toBeUndefined();
  });

  it('retains the creation-selected approval profile and its provenance across host recovery', () => {
    const run = { ...baseRun(undefined), approvalProfileId: 'profile:project', approvalProfileTeamOrGroupDerived: true };
    expect(projectRetainedExecutionRunState(run)).toMatchObject({
      approvalProfileId: 'profile:project', approvalProfileTeamOrGroupDerived: true,
    });
  });
  it('rehydrates the captured native sandbox without consulting new creation defaults', () => {
    const run = baseRun({ nativeSandbox: 'off' });
    expect(projectRetainedExecutionRunState(run).launch).toMatchObject({ nativeSandbox: 'off' });
    expect(resolveExecutionRunResumeBackendOptions({ run })).toMatchObject({ nativeSandbox: 'off' });
  });
  it.each(['explicit', 'inherited', 'independent', 'retained'] as const)(
    'projects only proven explicit model intent from a historical %s launch', selectionSource => {
      const run = baseRun({ selectionSource, modelId: 'custom/native' });
      expect(resolveExecutionRunResumeBackendOptions({ run })).toMatchObject({
        modelId: 'custom/native', modelSelectionSource: selectionSource === 'explicit' ? 'explicit' : 'inherited',
      });
      expect(projectRetainedExecutionRunState(run).launch).toEqual(run.launch);
    },
  );

  it('rehydrates the immutable Run tool policy without inheriting parent grants', () => {
    const run = baseRun({
      allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny',
    });
    expect(projectRetainedExecutionRunState(run).launch).toMatchObject({
      allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny',
    });
    expect(resolveExecutionRunResumeBackendOptions({ run }).start)
      .toMatchObject({ allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' });
  });

  it('retains the admitted hands-off ceiling when the backend is recreated', () => {
    expect(resolveExecutionRunResumeBackendOptions({
      run: { ...baseRun(undefined), workspaceWrites: 'deny', permissionMode: 'yolo' },
    })).toMatchObject({ workspaceWrites: 'deny' });
  });

  it('rehydrates the exact Team credential model selection for re-authorization on resume', () => {
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-team',
      teamId: 'team-1',
      expectedResourceRevision: 8,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
      deliveryMode: 'brokered' as const,
    };
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: teamCredentialModel.modelId, teamCredentialModel }),
    });
    expect(options).toMatchObject({
      modelId: teamCredentialModel.modelId,
      teamCredentialModel,
    });
  });

  it('rehydrates the exact model selection, config overrides, and SAME persisted CS selection', () => {
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({
        modelId: 'gpt-5.5',
        modelSelection: MODEL_SELECTION,
        sessionConfigOptionOverrides: OVERRIDES,
        connectedServicesSelection: CONNECTED_SELECTION,
        acpSessionModeId: 'plan',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } },
      }),
    });
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.modelSelection).toEqual(MODEL_SELECTION);
    expect(options.sessionConfigOptionOverrides).toEqual(OVERRIDES);
    // The persisted selection is authoritative on resume — the daemon re-materializes it verbatim.
    expect(options.connectedServices).toEqual(CONNECTED_SELECTION);
    expect(options.start).toMatchObject({
      acpSessionModeId: 'plan',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } },
    });
  });

  it('rehydrates the exact value-free Saved Secret overlay for fresh materialization', () => {
    const secretReferenceOverlay = {
      v: 1 as const,
      bindings: {
        API_KEY: { ref: 'happier:shared-secret:v1:resource', revision: 9 },
      },
    };
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({ secretReferenceOverlay }),
    });
    expect(options.secretReferenceOverlay).toEqual(secretReferenceOverlay);
    expect(JSON.stringify(options)).not.toContain('secret-value');
  });

  it('carries a persisted native (opt-out) selection through so resume honors the opt-out explicitly', () => {
    const nativeSelection: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: { 'openai-codex': { source: 'native' } },
    };
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({ connectedServicesSelection: nativeSelection }),
    });
    expect(options.connectedServices).toEqual(nativeSelection);
  });

  it('omits connectedServices when the launch record had no connected selection', () => {
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: 'gpt-5.5' }),
    });
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.connectedServices).toBeUndefined();
    expect(options.sessionConfigOptionOverrides).toBeUndefined();
  });

  it('rehydrates the admitted start intent with profileId and intentInput from the run record', () => {
    const options = resolveExecutionRunResumeBackendOptions({
      run: {
        ...baseRun({ modelId: 'gpt-5.5' }),
        profileId: 'review_profile',
        profileSourceCustody: { kind: 'development', registeredRootId: '/plugins/review' },
        intentInput: { commitModelSelection: MODEL_SELECTION },
      },
    });
    expect(options.start).toEqual({
      intent: 'delegate',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      profileId: 'review_profile',
      profileSourceCustody: { kind: 'development', registeredRootId: '/plugins/review' },
      intentInput: { commitModelSelection: MODEL_SELECTION },
    });
  });

  it('rehydrates the admitted start intent even when the run has no launch record (Voice runs)', () => {
    const options = resolveExecutionRunResumeBackendOptions({ run: baseRun(undefined) });
    expect(options.start).toEqual({
      intent: 'delegate',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    expect(options.modelId).toBeUndefined();
    expect(options.connectedServices).toBeUndefined();
  });

  it('returns empty options when there is no run', () => {
    expect(resolveExecutionRunResumeBackendOptions({ run: null })).toEqual({});
  });
});
