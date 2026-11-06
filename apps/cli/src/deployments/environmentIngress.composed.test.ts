import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployment-protocol';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';

// Only HTTP and the host identity adapters are substituted; requester admission stays real.
afterEach(() => { vi.restoreAllMocks(); });

const ownerContext: RpcActionExecutorContext = { authority: 'present_user', signal: new AbortController().signal,
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-a',
        installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
const ownerIdentity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
    resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner' }) });
const resolveOwnerRequesterIdentity = async (context: import('@happier-dev/protocol').ActionExecutorContext) => {
    const requester = await ownerIdentity.resolveActionRequester!(context);
    try { return requester.identity; } finally { await requester.dispose(); }
};

it.each((['plain', 'e2ee'] as const).flatMap(mode =>
    (['ui', 'mcp', 'denied Manage'] as const).map(entry => ({ mode, entry }))))(
    'prepares current-reference ingress through the admitted $entry Action in $mode mode', async ({ mode, entry }) => {
    const environment = createDeploymentEnvironmentDetailV1();
    const original = { ...environment.content, ingress: undefined };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(32).fill(57);
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : {
        type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey) } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : Buffer.from(encryptWithDataKey(value, resource.dataKey)).toString('base64');
    const originalArtifact = { id: environment.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
        publicAudience: 'none', encryptionMode: mode,
        dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
        header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: original.name }),
        body: encode({ body: JSON.stringify(original) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const artifacts = new Map<string, Record<string, unknown>>([[originalArtifact.id, originalArtifact]]);
    const artifactWrites: string[] = [];
    const storageWrites: ReturnType<typeof DeploymentActionInputSchemasV1['deployments.environments.update']['parse']>[] = [];
    // Home HTTP is the boundary; requester admission, Action routing,
    // private codecs and Environment preparation remain production code.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
        if (url.includes('/v1/artifacts/')) {
            const artifact = artifacts.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
            return { status: artifact ? 200 : 404, data: artifact ?? {} };
        }
        throw new Error('Unexpected ingress preparation read');
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
        expect(url).toBe('https://home.test/v1/artifacts');
        if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string')
            throw new Error('Expected a protected Environment Artifact');
        artifactWrites.push(body.id);
        artifacts.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
            encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
            environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        expect(request.method).toBe('PATCH');
        storageWrites.push(DeploymentActionInputSchemasV1['deployments.environments.update'].parse(request.data));
        return { status: 200, data: { ok: true, environmentId: environment.environment.id,
            revision: environment.environment.revision + 1 } };
    });
    const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity,
        runtime: { async acquire() { throw new Error('An ingress edit cannot acquire a native deployment'); } } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const actionId = 'deployments.environments.update' as const;
    const ingress = { kind: 'cloudflareTunnel' as const };
    const surface = entry === 'ui' ? 'ui' : 'mcp';
    const context: ActionExecutorContext = { ...ownerContext, surface,
        actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable',
        actionsSettings: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined),
            actionId, surface, approvalRequired: false }),
        machineAdmission: { ...ownerContext.machineAdmission!, encryptionMode: mode,
            role: entry === 'denied Manage' ? 'use' : 'manage' } };
    const result = await executor.execute(actionId, { serverId: 'home', environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, contentArtifactId: environment.environment.contentArtifactId,
        contentHeaderVersion: environment.environment.contentHeaderVersion, contentBodyVersion: environment.environment.contentBodyVersion,
        patch: { ingress } }, context);
    if (entry === 'denied Manage') {
        expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        expect(artifactWrites).toEqual([]);
        expect(storageWrites).toEqual([]);
        return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, environmentId: environment.environment.id,
        revision: environment.environment.revision + 1 } });
    expect(artifactWrites).toHaveLength(1);
    expect(storageWrites).toHaveLength(1);
    const stored = storageWrites[0]!;
    expect(stored).toMatchObject({ patch: { ingress }, expectedRevision: environment.environment.revision });
    expect(stored.contentArtifactId).not.toBe(environment.environment.contentArtifactId);
    expect(stored.contentArtifactId).toBe(artifactWrites[0]);
    const artifact = await runWithServerHttpBaseUrl('https://home.test', () =>
        createCredentialedAccountArtifactStore(credentials).read(stored.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
    const candidate = readDeploymentEnvironmentArtifactV1(stored, artifact);
    expect(candidate).toMatchObject({ ok: true, content: { ...original, ingress } });
    expect(artifacts.get(originalArtifact.id)).toEqual(originalArtifact);
});
