import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedRunLaunchFixture } from './managedRunLaunch.testkit';
import { prepareProviderLaunch } from './prepareLaunch';
const service = { pluginId: 'acme.shared-registry', localId: 'accounts' };
const provider = { pluginId: 'acme.shared-registry', localId: 'gateway' };
describe('Agent managed Connected Account purpose launch', () => {
  it('refuses an explicit experimental source until its exact catalog source is confirmed', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-consent-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, experimental: true, connectedAccountModels: [{ id: 'example', name: 'Example' }],
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider, purpose: 'upstream', modelIdPrefix: 'native/' } }] });
      try {
        const result = await prepareProviderLaunch({
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: null, modelId: 'native/example' } },
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices: { v: 2, bindingsByServiceId: { 'acme.shared-registry/accounts': { source: 'connected', profileId: 'upstream-account' } } },
          featureEnabled: true, resolvePrerequisites: async () => ({ ok: true }),
          createAuthorizationAttempt: async () => { throw new Error('Saved connection path'); },
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir,
            resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection },
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'provider_compatibility_unverified' } });
      } finally { await fixture.cleanup(); }
    });
  });
  it.each(['session', 'execution_run'] as const)('admits %s through managed custody, refuses a missing model, and recovers on a fresh launch', async kind => {
    await withConfiguredDaemonTestHome({ prefix: 'purpose-launch-' }, async ({ homeDir }) => {
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        physicalGateway: true, connectedAccountModels: [{ id: 'example', name: 'Example' }],
        resolveAccountTarget: async (target, signal) => { signal.throwIfAborted();
          return { account: { service, accountId: 'upstream-account' }, displayName: 'Selected source',
            ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: 1 } } : {}) }; },
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider, purpose: 'upstream', modelIdPrefix: 'native/' } }],
      });
      const unexpected = async (): Promise<never> => { throw new Error('Persisted Provider connection path must not run'); };
      try {
        let selections = 0;
        const connectedServices = { v: 2 as const, bindingsByServiceId: {
          'acme.shared-registry/accounts': kind === 'session'
            ? { source: 'connected' as const, profileId: 'upstream-account' }
            : { source: 'connected' as const, selection: 'group' as const, groupId: 'source-pool' } } };
        const launch = (modelId: string, featureEnabled = true) => prepareProviderLaunch({
          selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: null, modelId } },
          backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
          machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
          connectedServices,
          featureEnabled, resolvePrerequisites: unexpected, createAuthorizationAttempt: unexpected,
          managedPurposeContext: { lease: fixture.lease, happyHomeDir: homeDir,
            resolveManagedPurposeBindingIntentSelection: async request => { selections++; return await fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection(request); } },
        });
        expect(await launch('native/example', false)).toMatchObject({ ok: false, error: { code: 'provider_feature_disabled' } });
        expect(selections).toBe(0);
        expect(await launch('native/missing')).toMatchObject({ ok: false, error: { code: 'provider_model_not_found' } });
        const admitted = await launch('native/example');
        expect(admitted).toMatchObject({ ok: true, kind: 'managedPurpose',
          model: { id: 'example' },
          connectedServices });
        if (!admitted.ok || admitted.kind !== 'managedPurpose') throw new Error('Expected managed purpose');
        const materialized = await admitted.materialize(kind === 'session' ? { kind, sessionId: 'session-purpose' } : { kind, executionRunId: 'run-purpose' });
        expect(materialized).toMatchObject({ ok: true, providerBinding: { source: { kind: 'connected_account', account: { service, accountId: 'upstream-account' } }, model: { id: 'example' } } });
        if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
        expect(selections).toBe(2);
        const endpoint = materialized.environmentOverlay.find(entry => entry.name === 'RUN_PROVIDER_URL')!.value!;
        const credential = materialized.environmentOverlay.find(entry => entry.name === 'RUN_PROVIDER_TOKEN')!.value!;
        expect(new URL(endpoint).hostname).toBe('127.0.0.1');
        const request = () => fetch(endpoint + '/responses', { method: 'POST', headers: {
          authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
          body: JSON.stringify({ model: materialized.providerBinding.model.id, input: 'managed source request' }) });
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
        expect((await readFile(join(homeDir, 'fixture', 'gateway-inputs'), 'utf8')).trim()).toBe('managed source request');
        expect((await readFile(join(homeDir, 'fixture', 'gateway-starts'), 'utf8')).trim().split('\n')).toHaveLength(1);
        expect(await materialized.revalidateBeforeCommit()).toEqual({ ok: true });
        await materialized.cleanup();
        await expect(request()).rejects.toThrow();
      } finally { await fixture.cleanup(); }
    });
  });
});
