import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import axios from 'axios';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { expect, it, vi } from 'vitest';
import * as installationStore from '@/daemon/identity/store';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createDeploymentTargetRoleAdmissionFixture } from './deploymentTargetRoleAdmission.testkit';
import { withOwnServerBuildFixture } from './ownServer/buildReceipt.testkit';
import { createDeploymentSourceMaterializationPort } from './ownServer/exactCommitRelease';
import { createDeploymentTargetRoleExecEnvironmentForHost } from './createDeploymentTargetRoleExecEnvironmentForHost';
import { sealMachineSecretGrant } from '../secrets/machineSecretGrant';

it.each([false, true])('retires a finite runtime Iroh attachment without an unhandled close rejection (close fails: %s)', async closeFails => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, receipt, root, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The serving reference owner must be mounted');
        const lifetime = new AbortController();
        const cleanup: Readonly<{ dispose(): void | Promise<void> }>[] = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', onUnhandled);
        const server = createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener required');
        let closed = false;
        const originalHttp = axios.request.bind(axios);
        const keys = nacl.sign.keyPair.fromSeed(custody.installations.find(row => row.installationId === 'installation-c')!.seed);
        const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'installation-c', createdAt: 1,
            publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') });
        const binding = { purpose: 'variable', phase: 'runtime', name: 'DATABASE_URL',
            source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' } } as const;
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues',
            environmentId: environment.environment.id, machineId: host.machineId, installationId: 'installation-c',
            binding: { purpose: binding.purpose, phase: binding.phase, name: binding.name } },
            installationPublicKey: keys.publicKey, content: { kind: 'environmentValues', definition: binding.source } });
        // Signed Home HTTP and the TCP forward are genuine system boundaries.
        const http = vi.spyOn(axios, 'request').mockImplementation(async config =>
            config.url?.endsWith('/secret-launch-admission')
                ? { status: 200, data: { ok: true, grants: [grant] } }
                : originalHttp(config));
        const definition = await normalizeStoredComposeDefinitionInput({ from: 'image', image: 'nginx:alpine', port: 80 });
        const source = await createDeploymentSourceMaterializationPort({ async admit() {
            return { environmentId: environment.environment.id, deploymentId: receipt.deployment.id,
                machineId: host.machineId, installationId: 'installation-c', environmentInstanceId: 'runtime-fixture',
                deploymentRoot: join(root, 'runtime'), artifactDirectory: join(root, 'runtime-artifacts'),
                definition, async assertCurrent() { lifetime.signal.throwIfAborted(); } };
        } }).materialize({ environmentId: environment.environment.id, deploymentId: receipt.deployment.id });
        const stored = createDeploymentTargetRoleAdmissionFixture('deploy');
        environment.content.bindings = [binding];
        const roleHost = { ...host, installationId: 'installation-c', credentialOwnerAccountId: 'account-owner',
            credentials: { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`, encryption: null },
            resolveRequesterIdentity: stored.host.resolveRequesterIdentity,
            async assertCurrent() { lifetime.signal.throwIfAborted(); },
            async readEnvironment() { return referenceEnvironment; },
            async readReceipt() { return receipt; },
            async acquireServiceExportForward() { return { host: '127.0.0.1', port: address.port, observedPath: 'direct' as const,
                async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                    closed = true; if (closeFails) throw new Error('TCP carrier close failed'); } }; },
        };
        const port = createDeploymentTargetRoleExecEnvironmentForHost({ host: roleHost, source,
            admission: { input: stored.input, role: 'deploy', environment, receipt,
                executionEnvironment: { phase: 'runtime', machineId: host.machineId, installationId: 'installation-c' },
                workloadControl: { operationId: receipt.deployment.actionOperationId, kind: 'deployments.deploy' } },
            context: request.context, signal: lifetime.signal, retainCleanup: resource => { cleanup.push(resource); },
            readOwner: () => lease.registry.projectManagedServices });
        try {
            const attachment = await port.prepare({ source, phase: 'runtime' });
            attachment.dispose();
            await Promise.allSettled(cleanup.map(resource => resource.dispose()));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(closed).toBe(true);
            expect(server.listening).toBe(false);
            expect(unhandled).toEqual([]);
            lifetime.abort();
            await expect(port.prepare({ source, phase: 'runtime' })).rejects.toMatchObject({ data: { code: 'unavailable' } });
        } finally {
            lifetime.abort();
            await Promise.allSettled(cleanup.map(resource => resource.dispose()));
            await source.abort(); http.mockRestore(); installation.mockRestore(); process.off('unhandledRejection', onUnhandled);
            if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
            await lease.release();
        }
    }, { mode: 'stored', buildReference: true, referenceBindAddress: '127.0.0.1', referenceIroh: true });
});
