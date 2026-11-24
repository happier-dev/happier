import { expect, it } from 'vitest';
import { bindRequesterSessionCredentialScope } from '@/persistence';
import { resolveDetachedRunManagedDefaults } from './resolveDetachedRunManagedDefaults';

it('preserves the selected runner model through detached Account defaults', async () => {
  const resolved = await resolveDetachedRunManagedDefaults({
    sessionId: null, intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'clawpatch' },
    runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    modelId: 'runner-model', connectedServices: null, permissionMode: 'read_only',
    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    promptCredentials: bindRequesterSessionCredentialScope({ token: 'fixture', encryption: null }, {
      serverId: 'fixture-home', serverHttpBaseUrl: 'https://fixture.invalid',
    }),
  }, { machineId: 'fixture-machine', agentSandbox: {
    machineIsolation: null, machineIsolationPolicy: null, nativeSandboxAvailable: false,
  } });
  expect(resolved?.modelSelection).toMatchObject({
    agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'runner-model',
  });
});
