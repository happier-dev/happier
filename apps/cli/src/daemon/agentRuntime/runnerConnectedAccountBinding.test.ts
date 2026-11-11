import { expect, it } from 'vitest';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { readRunnerConnectedAccountBinding } from './runnerConnectedAccountBinding';

it.each(['session', 'run'] as const)('SDK %s services use the admitted account after the durable selection changes', async kind => {
  const consumer = { pluginId: 'acme.alpha', localId: 'agent' };
  const service = { pluginId: 'acme.alpha', localId: 'account' };
  const materialized: string[] = [];
  const fixture = createForegroundPurposeOwnerFixture({ consumer, service, accountId: 'admitted',
    materializeAccount: async input => { materialized.push(input.account.accountId); return { kind: 'environment', env: { TOKEN: 'fixture' } }; } });
  const lease = fixture.owner.activatePurposeBindings({ subject: { kind: 'operation', operationId: kind, consumer, isCurrent: () => true },
    purposes: [fixture.purpose], bindings: [fixture.binding] });
  const registry = new ConnectedServiceRuntimeRegistry();
  registry.registerTarget({ pid: 123, sessionId: 'session', exactPurposeBindingSubjectId: kind === 'session' ? lease.subjectId : 'parent-subject' });
  if (kind === 'run') registry.registerRunTarget({ pid: 123, sessionId: 'session', runKey: 'run', exactPurposeBindingSubjectId: lease.subjectId });
  await fixture.store.update(() => ({ v: 1, bindings: [{ ...fixture.binding,
    target: { kind: 'account', account: { service, accountId: 'durable-default' } } }] }));
  const owners = createProductionPluginInvocationServiceOwners({ connectedAccounts: fixture.owner });
  try {
    const services = owners.createOperationServices({ plugin: { id: consumer.pluginId, version: '1.0.0' },
      contribution: { id: consumer.localId, qualifiedId: 'acme.alpha/agents/agent' }, occurrenceId: '7', correlationId: kind,
      surface: 'agent', signal: new AbortController().signal, isOccurrenceCurrent: () => true }, {
      filesystemRoots: { pluginData: '/tmp/unused', workspace: '/tmp/unused', projects: new Map<string, string>() },
      ...readRunnerConnectedAccountBinding({ sessionId: 'session', ...(kind === 'run' ? { runKey: 'run' } : {}),
        connectedServiceRuntimeRegistry: registry, requester: { connectedAccountsOwner: fixture.owner, connectedServiceRuntimeRegistry: registry } }),
      hostAccessRequests: [{ required: true, request: { id: 'primary', capability: 'connectedAccounts', reason: 'Use admitted account',
        scope: { serviceRefs: ['account'], operations: ['use'], materializationKinds: ['environment'] } } }],
    });
    await expect(services.connectedAccounts.getBinding('primary')).resolves.toMatchObject({ account: { accountId: 'admitted' } });
    await services.connectedAccounts.materialize('primary', { kind: 'environment', keys: ['TOKEN'] });
    expect(materialized).toEqual(['admitted']);
  } finally { await lease.dispose(); owners.retireConnectedAccountConsumers(); }
});
