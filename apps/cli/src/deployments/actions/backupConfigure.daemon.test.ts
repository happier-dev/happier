import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentBackupConfigureInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';

afterEach(() => vi.restoreAllMocks());

it.each([
    { mode: 'plain', label: 'advanced', delta: 1, status: 200, wrongEnvironment: false, accepted: true },
    { mode: 'e2ee', label: 'advanced', delta: 1, status: 200, wrongEnvironment: false, accepted: true },
    { mode: 'plain', label: 'same-revision', delta: 0, status: 200, wrongEnvironment: false, accepted: true },
    { mode: 'plain', label: 'future-revision', delta: 2, status: 200, wrongEnvironment: false, accepted: false },
    { mode: 'plain', label: 'older-revision', delta: -1, status: 200, wrongEnvironment: false, accepted: false },
    { mode: 'plain', label: 'wrong-environment', delta: 1, status: 200, wrongEnvironment: true, accepted: false },
    { mode: 'plain', label: 'wrong-status', delta: 1, status: 201, wrongEnvironment: false, accepted: false },
] as const)('handles $label save responses through the $mode daemon backup writer before any Target exists', async ({ mode, delta, status, wrongEnvironment, accepted }) => {
    const detail = createDeploymentEnvironmentDetailV1();
    delete detail.content.backup;
    detail.targetLinks = [];
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(32).fill(7);
    const credentials = { token, encryption: mode === 'plain' ? null : {
        type: 'dataKey' as const, machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
    } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const created = new Map<string, ReturnType<typeof ArtifactJsonCreateHttpInputV1Schema.parse>>();
    const savedSecretRequests: string[] = [];
    const recordSavedSecretRequest = (url: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path.includes('/saved-secrets/')) savedSecretRequests.push(path);
        return path;
    };
    // Home HTTP is the boundary. Account codecs, Artifact publication, the daemon and configure coordinator remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = recordSavedSecretRequest(url);
        if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
        const id = path.split('/').at(-1)!;
        return { status: 200, data: { ...(created.get(id) ?? { id,
            header: encode({ kind: 'deployment-environment.v1', title: detail.content.name }),
            body: encode({ body: JSON.stringify(detail.content) }),
            dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey }),
            ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
        recordSavedSecretRequest(url);
        const parsed = ArtifactJsonCreateHttpInputV1Schema.parse(raw);
        created.set(parsed.id, parsed);
        return { status: 200, data: { id: parsed.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const writes: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        recordSavedSecretRequest(request.url);
        if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
            environment: detail.environment, targetLinks: [] } };
        expect(request.url).toBe(`https://home.test/v1/deployments/environments/${detail.environment.id}/backup`);
        writes.push(request.data);
        return { status, data: { ok: true, environmentId: wrongEnvironment ? 'other-environment' : detail.environment.id, revision: detail.environment.revision + delta } };
    });
    const artifacts = createCredentialedAccountArtifactStore(credentials);
    let nativeAcquisitions = 0;
    const deps = createDaemonDeploymentActionDeps({ credentials, accountArtifacts: artifacts, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'controller',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        readActiveBackupAutomationIds: async () => [],
        runtime: { async acquire() { nativeAcquisitions++; throw new Error('notNeeded cannot acquire native custody'); } } });
    const result = await deps.deploymentAction('deployments.backups.configure', { serverId: 'home',
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision, intent: 'markNotNeeded' }, {});
    if (!accepted) {
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
        return;
    }
    expect(result).toMatchObject({ kind: 'notNeeded', environmentId: detail.environment.id, revision: detail.environment.revision + delta });
    expect(writes).toEqual([{ serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        contentArtifactId: [...created.keys()][0], contentHeaderVersion: 1, contentBodyVersion: 1 }]);
    const saved = await runWithServerHttpBaseUrl('https://home.test', () => artifacts.read([...created.keys()][0]!, {
        prepareRecipients: false, includeSharedAudience: false }));
    expect(JSON.parse(saved!.body!)).toEqual({ ...detail.content, backup: { notNeeded: true } });
    const candidate = DeploymentBackupConfigureInputV1Schema.parse({ serverId: 'home',
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision, intent: 'save',
        configuration: { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'local' },
            occurrenceId: 'reviewed', config: { path: '/backups' },
            credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
            ownership: { environmentId: detail.environment.id, prefix: 'owned' },
            sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
            retention: { kind: 'keepEverything' } },
    });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-requester', binding: {
        accountId: 'requester', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: 'home', machineId: 'controller', installationId: 'installed-controller',
        environmentId: candidate.environmentId,
        actionId: 'deployments.backups.configure', requestId: 'configure-requester', requestEnvelopeDigest: 'A'.repeat(43),
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', candidate),
        target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: mode,
    } });
    // A signed Account B request without its admitted private custody cannot borrow Account A's daemon credentials.
    await expect(deps.deploymentAction('deployments.backups.configure', candidate,
        { externalActionExecutionAuthorization: authorization })).rejects.toMatchObject({ code: 'client_required' });
    expect(created.size).toBe(1);
    expect(writes).toHaveLength(1);
    expect(savedSecretRequests).toEqual([]);
    expect(nativeAcquisitions).toBe(0);
});

it.each(['single', 'missing', 'multiple'] as const)('uses admitted %s runtime placement for Another Machine before sender effects', async placement => {
    const detail = createDeploymentEnvironmentDetailV1();
    const runtime = detail.targetLinks[0]!.targetLink;
    runtime.machines = placement === 'multiple' ? ['source', 'source-other'] : ['source'];
    runtime.members = runtime.machines.map(machineId => ({ machineId, installationId: `installed-${machineId}`, state: 'active' }));
    detail.environment.runtimeTargetLinkId = placement === 'missing' ? undefined : runtime.id;
    detail.environment.controllerMachineId = 'controller';
    delete detail.content.backup;
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const machineReads: string[] = [];
    const writes: string[] = [];
    let environmentReads = 0;
    const network = { provider: { pluginId: 'happier.access.tailscale', localId: 'tailscale' },
        networkIdentity: 'private-network', displayName: null, dnsName: null, addresses: ['100.100.1.2'],
        state: 'ready', interfaceName: null, sourceRanges: [], magicDnsEnabled: null };
    // Genuine Home transport boundary: daemon registration, Account/Machine codecs,
    // Configure, placement selection and sender private-network preparation stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (path.startsWith('/v1/machines/')) {
            const id = path.split('/').at(-1)!;
            machineReads.push(id);
            const daemonState = StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', reachability: { revision: 1,
                management: { daemon: 'ready', providers: [], publicSsh: 'unknown' },
                privateNetworks: id === 'source' ? [] : [network], ingress: [] } });
            return { status: 200, data: { machine: MachinePublishedRowV1Schema.parse({ id, installationId: `installed-${id}`, metadata: null, metadataVersion: 0,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, daemonStateVersion: 1,
                daemonState: encodePlainMachineStoredContent(daemonState) }) } };
        }
        if (path === `/v1/artifacts/${detail.environment.contentArtifactId}`) return { status: 200, data: ArtifactHttpReadV1Schema.parse({
            id: detail.environment.contentArtifactId, header: encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: detail.content.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }) };
        throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method?.toUpperCase() === 'GET') {
            environmentReads++;
            return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: detail.environment,
                targetLinks: detail.targetLinks.map(({ targetLink }) => targetLink) }) };
        }
        writes.push(String(request.url));
        throw new Error('No sender or Setup mutation is admitted');
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => { writes.push(String(url)); throw new Error('No secret creation is admitted'); });
    const deps = createDaemonDeploymentActionDeps({ credentials, accountArtifacts: createCredentialedAccountArtifactStore(credentials),
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'controller',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        runtime: { async acquire() { throw new Error('No native acquisition is admitted'); } } });
    const input = DeploymentBackupConfigureInputV1Schema.parse({ serverId: 'home', environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision, intent: 'test', configuration: {
            configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'sftp' }, occurrenceId: 'reviewed',
            config: {}, credentialBindings: [], ownership: { environmentId: detail.environment.id, prefix: 'owned' },
            sources: [{ kind: 'volume', sourceId: 'database-data', service: 'database', volume: 'data', consistency: 'stopDuringCopy' }],
            retention: { kind: 'keepEverything' } }, destinationSetup: { kind: 'anotherMachine', machineId: 'receiver',
                expectedInstallationId: 'installed-receiver', receiverInputs: { endpoint: { host: '100.100.1.2', port: 2222 } } } });
    // The genuine child port is intentionally unadmitted; cold placement/network
    // facts must settle before any child invocation or secret generation.
    const context = { hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'deployments.backups.configure', input, context: {} }) };
    const result = await deps.deploymentAction('deployments.backups.configure', input, context);
    expect(machineReads.sort(), JSON.stringify(result)).toEqual(placement === 'single' ? ['receiver', 'source'] : []);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'setupIncomplete', errorCode: placement === 'single' ? 'no_shared_private_network' : 'source_unavailable' });
    expect(environmentReads).toBe(1);
    expect(writes).toEqual([]);
});


it('declares the existing password-binding child for a header-only re-key before native effects', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const deps = createDaemonDeploymentActionDeps({ credentials,
        accountArtifacts: createCredentialedAccountArtifactStore(credentials), serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'controller',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        runtime: { async acquire() { throw new Error('Child review cannot acquire native custody'); } } });
    const input = DeploymentBackupConfigureInputV1Schema.parse({ serverId: 'home', environmentId: 'environment',
        expectedRevision: 1, intent: 'rekeyAndSave',
        replacement: { ref: 'happier:shared-secret:v1:successor', resourceRevision: 1 } });
    expect(await deps.prepareHostReviewedChildren?.({ actionId: 'deployments.backups.configure', input, context: {} }))
        .toEqual({ children: [{ action: 'deployments.bindings.set', role: 'backup.bindings' }] });
});
