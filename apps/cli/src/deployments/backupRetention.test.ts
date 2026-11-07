import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('saves retention through the existing %s Environment update and private Artifact CAS', async mode => {
    const detail = createDeploymentEnvironmentDetailV1();
    detail.content.backup = { configRevision: 3, destinationRef: { pluginId: 'example.storage', localId: 'open' },
        occurrenceId: 'destination', config: { bucket: 'recovery' }, credentialBindings: [],
        ownership: { environmentId: detail.environment.id, prefix: 'backups' },
        sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }], retention: { kind: 'keepEverything' } };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(32).fill(7);
    const credentials = { token, encryption: mode === 'plain' ? null : {
        type: 'dataKey' as const, machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
    } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const created = new Map<string, ReturnType<typeof ArtifactJsonCreateHttpInputV1Schema.parse>>();
    // Substitute only Home HTTP. Account-mode codecs, the private writer and public Action transport remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
        const id = path.split('/').at(-1)!;
        const saved = created.get(id);
        return { status: 200, data: { ...(saved ?? { id, header: encode({ kind: 'deployment-environment.v1', title: detail.content.name }),
            body: encode({ body: JSON.stringify(detail.content) }),
            dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey }),
            ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.parse(raw);
        created.set(parsed.id, parsed);
        return { status: 200, data: { id: parsed.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const updates: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
            environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } };
        updates.push(request.data);
        return { status: 200, data: { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 } };
    });
    const artifacts = createCredentialedAccountArtifactStore(credentials);
    const host = { credentials, accountArtifacts: artifacts, serverHttpBaseUrl: 'https://home.test',
        resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) };
    const deps = createCliDeploymentActionDeps({ ...host, admitAccount: () => null,
        prepareEnvironment: createPrepareEnvironmentContentForHost(host),
        dispatchReceipt: async () => { throw new Error('Retention edits cannot dispatch native work'); } });
    const retention = { kind: 'keep' as const, last: 12, weekly: 4 };
    const input = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
        contentBodyVersion: detail.environment.contentBodyVersion, patch: { backupRetention: { configRevision: 3, retention } } };
    expect(await deps.deploymentAction!('deployments.environments.update', input, {})).toMatchObject({ ok: true });
    expect(updates).toEqual([expect.objectContaining({ expectedRevision: input.expectedRevision,
        contentArtifactId: [...created.keys()][0], patch: input.patch })]);
    const opened = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()][0]!, {
        prepareRecipients: false, includeSharedAudience: false,
    }));
    expect(JSON.parse(opened!.body!)).toEqual({ ...detail.content, backup: { ...detail.content.backup, retention } });
    for (const backup of [undefined, { notNeeded: true } as const]) {
        detail.content.backup = backup;
        expect(await deps.deploymentAction!('deployments.environments.update', input, {}))
            .toMatchObject({ ok: false, errorCode: 'backup_required' });
    }
    expect(updates).toHaveLength(1);
    expect(created.size).toBe(1);
});
