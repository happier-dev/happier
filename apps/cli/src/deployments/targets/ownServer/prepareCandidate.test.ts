import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import * as installationStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { prepareOwnServerDeploymentCandidate } from './prepareCandidate';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([undefined, ['db']] as const)('discovers only the requested service images without changing the exact source (%j)', async services => {
    const root = await mkdtemp(join(tmpdir(), 'happier-candidate-builder-'));
    const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    const keys = nacl.sign.keyPair();
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'builder-installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
        privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    try {
        const docker = await createOwnServerDockerBoundary(root);
        const image = await docker.registerImage('app', 'review');
        const databaseImage = await docker.registerImage('db', 'review');
        vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`);
        const environment = createDeploymentEnvironmentDetailV1();
        const serverUrl = services ? 'https://candidate-subset.test' : 'https://candidate-full.test';
        const profile = await addServerProfile({ name: services ? 'candidate-subset' : 'candidate-full', serverUrl, webappUrl: serverUrl });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: services ? 'srv_candidate_subset' : 'srv_candidate_full', canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: serverUrl }],
        } });
        environment.environment.serverId = profile.id;
        environment.environment.buildMachineId = 'builder';
        environment.content.ingress = { kind: 'cloudflareTunnel' };
        environment.targetLinks[0].targetLink.machines.push('machine-b');
        const document = JSON.stringify({ services: { app: { image: image.registryReference }, db: { image: databaseImage.registryReference } } });
        environment.content.definition = { kind: 'stored', contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app', 'db'] };
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            serverId: environment.environment.serverId, serverHttpBaseUrl: serverUrl, machineId: 'builder',
            async readEnvironmentSecretLaunchAdmission() { return { grants: [], async assertCurrent() {} }; },
            async acquirePluginRuntimeRegistryLease() { return mounted.lease; } });
        const candidate = await prepareOwnServerDeploymentCandidate({ environment,
            ...(services ? { services: [...services] } : {}),
            onFailure: 'keepPartial',
            targetLinkId: environment.targetLinks[0].targetLink.id, machineId: 'builder', async stageContent() { return 'review-only'; }, runtime,
            context: {} });
        expect(candidate.sourceIntent).toEqual(environment.content.definition);
        expect(candidate.buildMachineId).toBe('builder');
        expect(candidate.onFailure).toBe('keepPartial');
        expect(candidate.machines).toEqual(environment.targetLinks[0].targetLink.machines);
        expect(candidate.ingress).toEqual({ kind: 'cloudflareTunnel' });
        expect(candidate.images).toEqual(services ? [databaseImage] : [image, databaseImage]);
        expect(candidate).toMatchObject(services ? { services } : {});
        const invocations = await docker.readInvocations();
        expect(invocations.some(call => call.args[0] === 'buildx' && (call.args[1] === 'build'
            || call.args[1] === 'bake' && !call.args.includes('--print')
            || call.args[1] === 'imagetools' && call.args[2] === 'create'))).toBe(false);
        expect(invocations.some(call => call.args.includes('up')
            || call.args[0] === 'image' && ['pull', 'load', 'tag', 'push', 'rm'].includes(call.args[1]))).toBe(false);
    } finally { await mounted.dispose(); await rm(root, { recursive: true, force: true }); }
});
