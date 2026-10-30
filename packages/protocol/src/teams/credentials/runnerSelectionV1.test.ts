import { describe, expect, it } from 'vitest';

import {
  RunnerCredentialSelectionResolutionRequestV1Schema,
  RunnerCredentialSelectionResolutionResponseV1Schema,
} from './runnerSelectionV1.js';

const request = {
  v: 1 as const,
  selection: {
    kind: 'team_credential_provider_model' as const,
    resourceId: 'resource-a',
    teamId: 'team-a',
    expectedResourceRevision: 7,
    deliveryMode: 'brokered' as const,
    agentTargetKey: 'agent:happier.agent.codex/codex',
    modelId: 'gpt-5',
  },
  application: {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
    endpointTemplateId: 'responses',
    protocol: 'openai-responses' as const,
  },
  sourceRevision: 'source-revision-a',
  plannedSession: {
    primaryTeamId: 'team-a',
    teamVisibilityTeamIds: ['team-a'],
  },
};

describe('Runner credential selection resolution V1', () => {
  it('retains the exact content-free application and source incarnation in the reviewed binding', () => {
    expect(RunnerCredentialSelectionResolutionRequestV1Schema.parse(request)).toEqual(request);
    expect(RunnerCredentialSelectionResolutionResponseV1Schema.parse({
      v: 1, status: 'resolved',
      credentialSelectionBinding: {
        v: 1,
        resourceId: 'resource-a',
        brokerMachineId: 'broker-a',
        revision: 7,
        application: request.application,
        sourceRevision: request.sourceRevision,
      },
      displayFacts: { v: 1, homeId: 'home-a', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-a', teamName: '研究開発チーム 🌍' },
    })).toEqual({
      v: 1, status: 'resolved',
      credentialSelectionBinding: {
        v: 1,
        resourceId: 'resource-a',
        brokerMachineId: 'broker-a',
        revision: 7,
        application: request.application,
        sourceRevision: request.sourceRevision,
      },
      displayFacts: { v: 1, homeId: 'home-a', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-a', teamName: '研究開発チーム 🌍' },
    });
  });

  it('rejects mismatched Agent/application facts and unknown authority fields', () => {
    expect(RunnerCredentialSelectionResolutionRequestV1Schema.safeParse({
      ...request,
      application: { ...request.application, agentTargetKey: 'agent:happier.agent.opencode/opencode' },
    }).success).toBe(false);
    expect(RunnerCredentialSelectionResolutionRequestV1Schema.safeParse({
      ...request,
      creatorAccountId: 'caller-chosen',
    }).success).toBe(false);
    const response = {
      v: 1, status: 'resolved',
      credentialSelectionBinding: {
        v: 1,
        resourceId: 'resource-a',
        brokerMachineId: 'broker-a',
        revision: 7,
        application: request.application,
        sourceRevision: request.sourceRevision,
      },
      displayFacts: { v: 1, homeId: 'home-a', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-a', teamName: '研究開発チーム 🌍' },
    } as const;
    expect(RunnerCredentialSelectionResolutionResponseV1Schema.parse(response)).toEqual(response);
    expect(RunnerCredentialSelectionResolutionResponseV1Schema.safeParse({
      ...response,
      credentialSelectionBinding: { ...response.credentialSelectionBinding, modelId: 'gpt-5' },
    })).toMatchObject({
      success: false,
      error: { issues: [{ code: 'unrecognized_keys', path: ['credentialSelectionBinding'], keys: ['modelId'] }] },
    });
  });
});
