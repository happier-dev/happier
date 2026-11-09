import { describe, expect, it } from 'vitest';
import { resolveGroupRequiredModelIds } from './resolveGroupRequiredModelIds';

describe('resolveGroupRequiredModelIds', () => {
  it('PORT-PS-AB unions launched and current intent models only for live members of the exact group', () => {
    const model = (modelId: string, updatedAt: number) => ({ v: 1 as const, updatedAt,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId } });
    const session = (pid: number, modelId: string) => ({ pid, startedBy: 'daemon',
      spawnOptions: { directory: '/repo', backendTarget: { kind: 'backend' as const, backendId: 'codex' }, modelSelection: model(modelId, 1) } });
    const binding = (groupId: string) => ({ serviceId: 'happier.agent.codex/codex', groupId,
      profileId: 'primary', groupGeneration: 1, credentialRevision: null });
    expect(resolveGroupRequiredModelIds({ serviceId: 'happier.agent.codex/codex', groupId: 'pool',
      targets: [{ pid: 1, sessionId: null, activeBindings: [binding('pool')] },
        { pid: 2, sessionId: null, activeBindings: [binding('other-pool')] }],
      trackedSessions: [{ ...session(1, 'launched'), happySessionMetadataFromLocalWebhook: {
        modelSelectionIntentV1: { v: 1, updatedAt: 2, selection: model('next-model', 2).ref },
      } }, session(2, 'other-pool-model'), session(3, 'historical-model')],
    })).toEqual(['launched', 'next-model']);
  });
});
