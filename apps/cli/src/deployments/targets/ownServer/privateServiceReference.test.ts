import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerBuildFixture } from './buildReceipt.testkit';
import { resolvePrivateServiceReferenceForHost } from './privateServiceReference';

it('uses the current source member native service when a partial rollout leaves an older or absent uniform pointer', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            const resolve = () => resolvePrivateServiceReferenceForHost({
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
            });
            referenceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId = 'previous-uniform-generation';
            await expect(resolve()).resolves.toBe('postgres://100.64.0.7:25432');
            referenceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId = null;
            await expect(resolve()).resolves.toBe('postgres://100.64.0.7:25432');
        } finally { await lease.release(); }
    }, { buildReference: true });
});
