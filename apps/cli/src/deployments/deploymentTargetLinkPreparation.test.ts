import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

afterEach(() => vi.restoreAllMocks());

describe('provider link preparation through the installed Action host', () => {
    it.each([
        ['plain', 'match'], ['e2ee', 'match'], ['plain', 'partial'], ['e2ee', 'partial'],
        ['plain', 'denied'], ['e2ee', 'denied'], ['plain', 'mode-mismatch'], ['e2ee', 'wrong-key'],
    ] as const)('compares another Source’s normalized link for two %s Team recipients (%s) before writing', async (mode, comparison) => {
        const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } } as const;
        const owner = { kind: 'team', teamId: 'shared-team' } as const;
        const current = createDeploymentEnvironmentHeaderV1({ owner });
        const existing = createDeploymentEnvironmentHeaderV1({ id: 'other-environment', projectSourceId: 'other-source', owner });
        const link = createDeploymentTargetLinkHeaderV1({ id: 'other-link', environmentId: existing.id,
            source, targetKind: 'platform', machines: [], members: [] });
        const providerIdentity = { providerAccountId: 'native-account', providerResourceId: 'native-resource', providerEnvironment: 'production' };
        const dataKey = randomBytes(32);
        const encode = (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, dataKey));
        const stored = { id: link.contentArtifactId, ownerAccountId: 'other-owner', access: 'view', encryptionMode: mode,
            publicAudience: 'none', header: encode({ kind: 'deployment-target-link.v1', title: 'Existing destination' }),
            body: encode({ body: JSON.stringify({ providerIdentity }) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 };
        const requests: string[] = [];
        const artifactWrites = vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('Duplicate preparation must not write'); });
        const envelopes: string[] = [];
        for (const recipient of ['first-recipient', 'second-recipient']) {
            const secret = randomBytes(32);
            const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: recipient })).toString('base64url')}.s`,
                encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey: secret, publicKey: x25519.getPublicKey(secret) } };
            const envelope = mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                dataKey, recipientPublicKey: x25519.getPublicKey(comparison === 'wrong-key' ? randomBytes(32) : secret), randomBytes }));
            envelopes.push(envelope);
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
                if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
                expect(path).toBe(`/v1/artifacts/${link.contentArtifactId}`);
                if (comparison === 'denied') return { status: 403, data: { error: 'artifact_access_denied' } };
                return { status: 200, data: { ...stored, dataEncryptionKey: envelope,
                    ...(comparison === 'mode-mismatch' ? { encryptionMode: 'e2ee' } : {}) } };
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(request.url!).pathname;
                requests.push(path);
                if (request.method === 'GET') return { status: 200, data: { ok: true, environment: current, targetLinks: [] } };
                if (path !== '/v1/deployments/targets/list') throw new Error('Duplicate preparation reached association');
                expect(request.data.scope).toEqual(owner);
                return { status: 200, data: { ok: true, items: request.data.cursor ? [{ environment: existing, targetLink: link }] : [],
                    coverage: comparison === 'partial' ? 'partial' : 'complete', nextCursor: request.data.cursor ? null : 'next-page' } };
            });
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://link.test',
                machineId: 'controller', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                acquirePluginRuntimeRegistryLease: async () => { throw new Error('Link preparation cannot execute native effects'); } });
            const deps = createDaemonDeploymentActionDeps({ credentials, accountArtifacts: createCredentialedAccountArtifactStore(credentials),
                serverId: 'home', serverHttpBaseUrl: 'https://link.test', machineId: 'controller', runtime,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
            const result = await deps.deploymentAction('deployments.targets.link', { serverId: 'home', environmentId: current.id,
                expectedRevision: current.revision, requestKey: 'link-provider', source, targetId: 'platform', targetKind: 'platform',
                role: 'runtime', machines: [], provider: { credentialPrincipal: { kind: 'account', accountId: recipient,
                    purpose: { consumer: { pluginId: 'example.deploy', localId: 'platform' }, purpose: 'manage' },
                    target: { kind: 'account', account: { service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' } } },
                    providerIdentity, providerEnvironment: { kind: 'production' } } }, {});
            if (comparison === 'match') expect(result).toEqual({ ok: false, error: 'provider_scope_already_linked', environment: {
                serverId: 'home', projectSourceId: existing.projectSourceId, environmentId: existing.id }, targetLinkId: link.id });
            else {
                const error = comparison === 'partial' ? 'deployment_content_unavailable'
                    : comparison === 'denied' ? 'artifact_read_unavailable'
                        : comparison === 'mode-mismatch' ? 'artifact_account_mode_mismatch' : 'client_required';
                expect(result).toMatchObject({ ok: false, errorCode: error });
                expect(result).not.toHaveProperty('targetLinkId');
                expect(result).not.toHaveProperty('environment');
            }
        }
        if (mode === 'e2ee') expect(envelopes[0]).not.toEqual(envelopes[1]);
        expect(requests.filter(path => path === '/v1/deployments/targets/list')).toHaveLength(comparison === 'partial' ? 2 : 4);
        expect(artifactWrites).not.toHaveBeenCalled();
    });
});
