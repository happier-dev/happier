import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { readCliSessionEngineBaselineV1 } from './resolveCliAgentStartContextV1';

const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
const agentTargetKey = buildBackendTargetKeyV2(backendTarget);

describe('CLI Session engine baseline', () => {
  it.each([undefined, { status: 'unavailable' } as const])('leaves the model absent without an applied selection (%j)', appliedChildSelection => {
    expect(readCliSessionEngineBaselineV1({ backendTarget, appliedChildSelection })).toEqual({
      modelSelection: undefined,
      defaultEngine: { agentTargetKey },
    });
  });

  it('preserves the applied provider route and projects legacy native model observations', () => {
    const modelSelection = { agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('applied-provider'), modelId: 'applied-model' };
    expect(readCliSessionEngineBaselineV1({ backendTarget, appliedChildSelection: {
      status: 'applied', modelId: modelSelection.modelId, modelSelection,
    } })).toEqual({ modelSelection, defaultEngine: { agentTargetKey, modelId: 'applied-model' } });
    expect(readCliSessionEngineBaselineV1({ backendTarget, appliedChildSelection: {
      status: 'applied', modelId: modelSelection.modelId,
    } })).toEqual({ modelSelection: { ...modelSelection, providerConnectionId: null }, defaultEngine: { agentTargetKey, modelId: 'applied-model' } });
  });

  it('leaves applied Team custody to child admission instead of fabricating a native route', () => {
    expect(readCliSessionEngineBaselineV1({ backendTarget, appliedChildSelection: {
      status: 'applied', modelId: 'team-model',
      teamCredentialModel: {
        kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
        expectedResourceRevision: 2, agentTargetKey, modelId: 'team-model', deliveryMode: 'brokered',
      },
    } })).toEqual({ modelSelection: undefined, defaultEngine: { agentTargetKey } });
  });
});
