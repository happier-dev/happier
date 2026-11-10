import { expect, it } from 'vitest';

import { resolveConnectedServiceNativeHomeTarget } from './resolveConnectedServiceNativeHomeTarget';
import type { AgentSpawnQualifiedPurposeBindingSnapshot } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';

it.each([
  { description: 'omitted file purposes', fileMaterializationPurposes: undefined },
  { description: 'empty file purposes', fileMaterializationPurposes: [] },
])('does not allocate a durable native home for request-auth-only bindings ($description)', ({ fileMaterializationPurposes }) => {
  const purpose = {
    consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
    purpose: 'model_upstream',
  };
  const snapshot: AgentSpawnQualifiedPurposeBindingSnapshot = {
    purposes: [purpose],
    bindings: [{
      purpose,
      target: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.test.accounts', localId: 'model' },
          accountId: 'work',
        },
      },
    }],
    ...(fileMaterializationPurposes === undefined ? {} : { fileMaterializationPurposes }),
  };

  expect(resolveConnectedServiceNativeHomeTarget({
    agentId: 'codex',
    activeServerDir: '/fixture/server',
    nativeHome: {
      environmentKey: 'CODEX_HOME',
      defaultRelativePath: '.codex',
      materializedDirectoryName: 'codex-home',
    },
    snapshot,
  })).toBeNull();
});


it('selects an explicitly declared environment-only purpose through the same native account home layout', () => {
  const purpose = { consumer: { pluginId: 'acme.agent', localId: 'agent' }, purpose: 'selected-key' };
  const account = { service: { pluginId: 'acme.accounts', localId: 'key' }, accountId: 'work' };
  const nativeHome = { environmentKey: 'HOME', defaultRelativePath: '.', materializedDirectoryName: 'agent-home', purposes: ['selected-key'] };
  const snapshot: AgentSpawnQualifiedPurposeBindingSnapshot = { purposes: [purpose],
    authorizedPurposes: [{ purpose, serviceRefs: [account.service] }], fileMaterializationPurposes: [],
    bindings: [{ purpose, target: { kind: 'account', account } }],
  };
  expect(resolveConnectedServiceNativeHomeTarget({ agentId: 'acme.agent/agent', activeServerDir: '/fixture/server', nativeHome, snapshot }))
    .toMatch(/agent-home$/);
});
