import axios from 'axios';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create as createTar } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1 } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentCandidatePublicationV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as persistence from '@/persistence';
import * as installation from '@/daemon/identity/store';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createNativeComposeImageIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { nativeRegistryPause310 } from '@/daemon/local/services/launch/nativeComposeImageRegistry.testkit';
import { adoptOwnServerImageArchives } from './releaseProvenance';
import { createDeploymentImageArchiveCopyForHost } from './imageArchiveCopy';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';

afterEach(() => vi.restoreAllMocks());

describe('installed receipt image archive copy', () => {
    it.each(['explicit', 'compact_match', 'compact_mismatch'] as const)('admits exact primary source before reusing local archive bytes (%s)', async kind => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const directory = await mkdtemp(join(tmpdir(), 'happier-local-image-copy-'));
        let prepared: Awaited<ReturnType<typeof prepareInstalledRequesterAccountActionContext>> = null;
        let custodyReads = 0;
        try {
            const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(82));
            const identity = { version: 1 as const, createdAt: 1, installationId: 'installed',
                publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
            vi.spyOn(installation, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity);
            const credentials = { token: 'installed-account', encryption: null, credentialProvenance: 'stored_session' as const };
            const storedCredentials = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
            const primary = createDeploymentReceiptDetailV1().content;
            if (primary.sourceIntent.kind !== 'repository') throw new Error('Expected repository receipt fixture');
            primary.sourceIntent.sha = (kind === 'compact_mismatch' ? 'b' : 'a').repeat(40);
            const sourceReads: string[] = [];
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
                    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/artifacts/candidate')) {
                    sourceReads.push(url);
                    return { status: 200, data: { id: 'candidate', ownerAccountId: 'requester', access: 'owner',
                        publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        header: encodePlainArtifactStoredContent(createDeploymentReceiptArtifactHeaderV1('Primary receipt', primary)),
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(primary) }),
                        headerVersion: 3, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1 } };
                }
                throw new Error('Local adopted bytes must not resolve a remote transport');
            });
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
                machineId: 'machine', installationId: identity.installationId, phase: 'activate', deploymentId: 'receipt',
                selectedDeploymentId: 'receipt', actionOperationId: 'operation',
                input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
                    expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'root-request',
                target: { kind: 'machine', machineId: 'controller' }, input: kind === 'explicit' ? job.input : {
                    serverId: 'home', environmentId: 'environment', targetLinkId: 'link', requestKey: 'request', sha: 'a'.repeat(40),
                } });
            const requestId = envelope.requestId;
            if (!requestId) throw new Error('Expected the root request id in the child fixture');
            const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
                accountId: 'requester', custodianAccountId: 'controller-owner', accountEncryptionMode: 'plain', serverIdentityId: 'home',
                machineId: 'controller', installationId: 'controller-installation', actionId: job.actionId, requestId,
                requestEnvelopeDigest, target: envelope.target,
                deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'requester', serverIdentityId: 'home',
                    actionId: job.actionId, requestId, requestEnvelopeDigest, environmentId: job.input.environmentId,
                    source: { id: primary.sourceIntent.projectSourceId, revision: primary.sourceIntent.sourceRevision } }),
                authentication: { kind: 'account', tokenEpoch: 1 } } });
            const purpose = { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: job,
                recipient: { machineId: job.machineId, installationId: job.installationId } } as const;
            const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
                credentials: { token: 'requester-account', secret: null, encryption: null }, installationPublicKey: keys.publicKey,
                randomBytes: nacl.randomBytes });
            const packet = { method: `machine:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId: 'child-request', params: job,
                originalActionEnvelope: envelope, externalActionExecution: { v: 1 as const, authorization: sealed,
                    effectActionId: job.actionId, target: root.binding.target, installationId: root.binding.installationId,
                    machineSignature: 'a'.repeat(86), deploymentChildRouting: projectDeploymentChildRoutingV1(job) } };
            prepared = await prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
                deploymentChildExecution: packet, machineId: job.machineId, serverId: 'profile', serverHttpBaseUrl: 'https://home.test',
                verifyServiceMoveChildCurrent: async () => { custodyReads++; return true; },
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: job.machineId, serverIdentityId: 'home' }),
                createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
            expect(prepared).not.toBeNull();
            const variant = nativeRegistryPause310.variants[0];
            const config = Buffer.from(variant.config);
            const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
            const image = { service: 'app', platform: variant.platform, configDigest,
                manifestDigest: `sha256:${createHash('sha256').update(variant.manifest).digest('hex')}` };
            const configName = `${configDigest.slice(7)}.json`;
            const source = join(directory, 'native');
            await mkdir(source);
            await writeFile(join(source, configName), config);
            await writeFile(join(source, 'manifest.json'), JSON.stringify([{ Config: configName, Layers: [] }]));
            const tar = join(directory, 'image.tar');
            await createTar({ cwd: source, file: tar }, [configName, 'manifest.json']);
            const deploymentRoot = join(directory, 'deployments');
            // Docker's native process is the boundary; export, CONFIG parsing,
            // archive adoption and both custody checks stay real.
            const native = createNativeComposeImageIdentity({ directory: async () => source, async run(args) {
                if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Id: 'native-local-id' }]), exitCode: 0 };
                if (args[1] === 'tag') return { stdout: '', exitCode: 0 };
                if (args[1] === 'save') { await copyFile(tar, args[args.indexOf('--output') + 1]!); return { stdout: '', exitCode: 0 }; }
                throw new Error('Unexpected native image operation');
            } });
            const effectKeys = [{ kind: 'dockerEngine', dockerEndpoint: `native-export-boundary:${directory}` }] as const;
            const exported = await machineNativeEffectAdmission.run({ operation: { operationId: 'archive-export', kind: 'deployment' }, keys: effectKeys },
                context => native.exportImage(image, { references: ['owned:image'], ownedTag: 'owned:image', authority: { context } }));
            const [archive] = await adoptOwnServerImageArchives({ archives: [exported], serverId: 'home',
                admission: { deploymentRoot, environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'), deploymentId: 'receipt',
                    machineId: job.machineId, installationId: identity.installationId },
                signal: new AbortController().signal, async assertCurrent() {} });
            if (!archive) throw new Error('Native archive was not adopted');
            const destination = archive.holder;
            const transport = { sizeBytes: archive.sizeBytes, sha256: archive.sha256 };
            const copy = createDeploymentImageArchiveCopyForHost({ credentials, credentialProfileId: 'profile', serverId: 'home',
                serverHttpBaseUrl: 'https://home.test', machineId: job.machineId, installationId: identity.installationId, deploymentRoot });
            const context = { externalActionExecutionAuthorization: prepared!.authorization, originalActionEnvelope: envelope };
            const admittedCustodyReads = custodyReads;
            // Re-login changes credentials for the next invocation, not this
            // admitted finite deployment's archive acquisition.
            storedCredentials.mockResolvedValue({ ...credentials, token: 'next-login' });
            const admittedCredentialReads = storedCredentials.mock.calls.length;
            if (kind === 'compact_mismatch') {
                await expect(copy({ archive, destination, context, signal: new AbortController().signal, async assertCurrent() {} }))
                    .rejects.toMatchObject({ code: 'target_mismatch' });
                expect(sourceReads).toHaveLength(1);
                return;
            }
            await expect(copy({ archive, destination, context, signal: new AbortController().signal, async assertCurrent() {} }))
                .resolves.toEqual({ path: destination.path, ...transport });
            // The finite child already holds exact signed custody. Local byte
            // verification and the authorized source read do not re-admit it.
            expect(custodyReads).toBe(admittedCustodyReads);
            expect(storedCredentials.mock.calls.length - admittedCredentialReads).toBe(0);
            expect(sourceReads).toHaveLength(kind === 'explicit' ? 0 : 1);
            await writeFile(destination.path, 'substituted');
            await expect(copy({ archive, destination, context, signal: new AbortController().signal, async assertCurrent() {} }))
                .rejects.toMatchObject({ details: { reason: 'deployment_image_archive_identity_mismatch' } });
        } finally { await prepared?.dispose(); await channel.close(); await rm(directory, { recursive: true, force: true }); }
    });
});
