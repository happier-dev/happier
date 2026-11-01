import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '@/daemon/types';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { resolveConnectedServiceAuthGroupRequiredModelIds } from './resolveConnectedServiceAuthGroupRequiredModelIds';

function tracked(sessionId: string, pid: number, metadata: Partial<Metadata>): TrackedSession {
  return {
    happySessionId: sessionId, pid, startedBy: 'daemon',
    spawnOptions: { directory: '/project', modelId: 'old-model', modelUpdatedAt: 1 },
    happySessionMetadataFromLocalWebhook: {
      path: '/project', host: 'machine', homeDir: '/home/user', happyHomeDir: '/happier',
      happyLibDir: '/lib', happyToolsDir: '/tools', ...metadata,
    },
  };
}

describe('resolveConnectedServiceAuthGroupRequiredModelIds', () => {
  it('uses live group membership and current requested/applied models without retaining retired sessions', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const register = (sessionId: string, pid: number, groupId = 'main') => registry.registerTarget({
      sessionId, pid,
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId, profileId: 'primary' },
      } },
    });
    register('one', 1);
    register('two', 2);
    register('other', 3, 'other');
    const sessions = [
      tracked('one', 1, {
        modelOverrideV1: { v: 1, modelId: 'requested', updatedAt: 3 },
        sessionAppliedModelV1: { v: 1, provider: 'codex', modelId: 'applied', updatedAt: 2 },
      }),
      tracked('two', 2, {
        sessionModelsV1: { v: 1, provider: 'codex', currentModelId: 'native', updatedAt: 4, availableModels: [] },
        modelOverrideV1: { v: 1, modelId: 'requested', updatedAt: 3 },
      }),
      tracked('other', 3, { modelOverrideV1: { v: 1, modelId: 'other', updatedAt: 3 } }),
      tracked('retired', 4, { modelOverrideV1: { v: 1, modelId: 'retired', updatedAt: 3 } }),
    ];
    const resolve = () => resolveConnectedServiceAuthGroupRequiredModelIds({
      serviceId: 'openai-codex', groupId: 'main', targets: registry.listTargets(), sessions,
    });
    expect(resolve()).toEqual(['requested', 'applied', 'native']);
    registry.unregisterPid(1);
    expect(resolve()).toEqual(['requested', 'native']);
    registry.unregisterPid(2);
    expect(resolve()).toEqual([]);
  });
});
