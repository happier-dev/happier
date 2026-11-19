import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1,
    isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';

afterEach(() => vi.restoreAllMocks());

it.each((['plain', 'e2ee'] as const).flatMap(mode =>
    (['retention', 'setup', 'setupAction'] as const).map(edit => ({ mode, edit }))))('saves $edit through the existing $mode Environment content preparer', async ({ mode, edit }) => {
    const detail = createDeploymentEnvironmentDetailV1();
    detail.content.backup = { configRevision: 3, destinationRef: { pluginId: 'example.storage', localId: 'open' },
        occurrenceId: 'destination', config: { bucket: 'recovery' },
        credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
        ownership: { environmentId: detail.environment.id, prefix: 'backups' },
        sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }], retention: { kind: 'keepEverything' } };
    const configuration = detail.content.backup;
    if (edit !== 'retention') delete detail.content.backup;
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
    // The installed catalog is an environment boundary; the configuration writer and descriptor validation remain real.
    const host = { credentials, accountArtifacts: artifacts, serverHttpBaseUrl: 'https://home.test',
        acquirePluginRuntimeRegistryLease: async () => ({ registry: {
            contributes: { backupDestinations: [{ identity: configuration.destinationRef, definition: {
                id: 'open', title: 'External storage', credentialRoles: [{ role: 'repositoryPassword' as const }], resticTransport: 's3' as const, locality: 'offHost' as const,
                configSchema: { type: 'object', properties: { bucket: { type: 'string', minLength: 1 } },
                    required: ['bucket'], additionalProperties: false },
                actions: { test: configuration.destinationRef, open: configuration.destinationRef },
            } }] }, readPluginOccurrenceId: () => 'current-destination',
        }, release: async () => {} }),
        resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) };
    const prepare = createPrepareEnvironmentContentForHost(host);
    const deps = createCliDeploymentActionDeps({ ...host, admitAccount: () => null,
        prepareEnvironment: prepare,
        dispatchReceipt: async () => { throw new Error('Retention edits cannot dispatch native work'); } });
    const retention = { kind: 'keep' as const, last: 12, weekly: 4 };
    const input = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
        contentBodyVersion: detail.environment.contentBodyVersion, patch: edit !== 'retention'
            ? { backup: { ...configuration, retention } }
            : { backupRetention: { configRevision: 3, retention } } };
    if (edit === 'setup') {
        const result = await prepare({ actionId: 'deployments.environments.update', input, context: {} });
        expect(result).toMatchObject({ input: { patch: {} } });
        expect(created.size).toBe(1);
        const opened = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()][0]!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(opened!.body!)).toEqual({ ...detail.content,
            backup: { ...configuration, occurrenceId: 'current-destination', retention } });
        detail.content.backup = { ...configuration, occurrenceId: 'current-destination', retention };
        expect(await prepare({ actionId: 'deployments.environments.update', input, context: {} }))
            .toMatchObject({ input: { patch: {} } });
        expect(created.size).toBe(1);
        for (const [backup, errorCode] of [
            [{ ...configuration, config: { bucket: '' } }, 'invalid_destination_config'],
            [{ ...configuration, destinationRef: { pluginId: 'missing.storage', localId: 'open' } }, 'destination_changed'],
        ] as const) expect(await prepare({ actionId: 'deployments.environments.update',
            input: { ...input, patch: { backup } }, context: {} })).toMatchObject({ ok: false, errorCode });
        expect(created.size).toBe(1);
        expect(updates).toHaveLength(0);
        return;
    }
    const native = projectDeploymentNativeAdmissionV1('deployments.environments.update', input);
    const context = edit === 'setupAction' ? { externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1, token: 'host-preparation-proof', binding: { accountId: 'owner', custodianAccountId: 'owner',
            authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home', machineId: 'controller',
            installationId: 'installation', actionId: 'deployments.environments.update', requestId: 'setup',
            target: { kind: 'machine', machineId: 'controller' }, admittedMachineRole: 'manage', accountEncryptionMode: mode,
            requestEnvelopeDigest: 'a'.repeat(43), environmentId: detail.environment.id, deploymentNativeAdmission: native } }) } : {};
    expect(await deps.deploymentAction!('deployments.environments.update', input, context)).toMatchObject({ ok: true });
    if (edit === 'setupAction' && isDeploymentEnvironmentUpdateNativeAdmissionV1(native)) {
        expect(updates).toEqual([expect.objectContaining({ authoredInputDigest: native.inputDigest })]);
    }
    expect(updates).toEqual([expect.objectContaining({ expectedRevision: input.expectedRevision,
        contentArtifactId: [...created.keys()][0], patch: edit === 'setupAction' ? {} : input.patch })]);
    const opened = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()][0]!, {
        prepareRecipients: false, includeSharedAudience: false,
    }));
    expect(JSON.parse(opened!.body!)).toEqual({ ...detail.content, backup: { ...configuration, retention,
        ...(edit === 'setupAction' ? { occurrenceId: 'current-destination' } : {}) } });
    if (edit === 'setupAction') {
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { backup: { ...configuration, config: { bucket: '' } } } }, {}))
            .toMatchObject({ ok: false, errorCode: 'invalid_destination_config' });
        expect(updates).toHaveLength(1);
        expect(created.size).toBe(1);
        return;
    }
    for (const backup of [undefined, { notNeeded: true } as const]) {
        detail.content.backup = backup;
        expect(await deps.deploymentAction!('deployments.environments.update', input, {}))
            .toMatchObject({ ok: false, errorCode: 'backup_required' });
    }
    expect(updates).toHaveLength(1);
    expect(created.size).toBe(1);
});
