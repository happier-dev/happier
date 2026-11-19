import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';

afterEach(() => vi.restoreAllMocks());

const ownerContext: RpcActionExecutorContext = { authority: 'present_user', signal: new AbortController().signal,
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-a',
        installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
const ownerIdentity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
    resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner' }) });
const resolveOwnerRequesterIdentity = async (context: import('@happier-dev/protocol').ActionExecutorContext) => {
    const requester = await ownerIdentity.resolveActionRequester!(context);
    try { return requester.identity; } finally { await requester.dispose(); }
};

describe('native deployment builder availability', () => {
    it.each([
        [403, {}, 'http_refused'],
        [200, {}, 'invalid_publication'],
        [200, { id: 'guest-builder', active: true, kind: 'persistent', installationId: null,
            revokedAt: null, replacedByMachineId: null }, 'installation_missing'],
        [200, { id: 'guest-builder', active: false, kind: 'persistent', installationId: 'guest-installation',
            revokedAt: 1, replacedByMachineId: null }, 'installation_revoked'],
        [200, { id: 'guest-builder', active: false, kind: 'persistent', installationId: 'guest-installation',
            revokedAt: null, replacedByMachineId: null }, null],
    ] as const)('preserves builder installation admission before native preparation (%s, %s)', async (status, machine, reason) => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.buildMachineId = 'guest-builder';
        const documents = new Map<string, { kind: string; content: unknown }>([
            [environment.environment.contentArtifactId, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content: environment.content }],
            ...environment.targetLinks.map(row => [row.targetLink.contentArtifactId,
                { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, content: row.content }] as const),
        ]);
        // HTTP publication/storage and native acquisition are system boundaries;
        // candidate preparation and installation classification stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (url.endsWith('/v1/machines/guest-builder')) return { status, data: { machine } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            const document = documents.get(id);
            if (!document) return { status: 404, data: {} };
            return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Deployment' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => ({ status: 200, data:
            new URL(request.url!).pathname.endsWith('/deployments') ? { ok: true, items: [], nextCursor: null }
                : { ok: true, environment: environment.environment, secretScope: environment.secretScope,
                    targetLinks: environment.targetLinks.map(row => row.targetLink) } }));
        const acquire = vi.fn(async () => { throw new Error('Unexpected native effect'); });
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity, runtime: { acquire, acquireCandidate: acquire } });
        const result = await deps.prepareDeployCandidate({ environmentId: environment.environment.id, context: ownerContext });
        if (reason === null) {
            // Offline is not revocation: the valid publication reaches child
            // dispatch, where this unsigned local fixture has no root to spend.
            expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        } else expect(result).toMatchObject({ ok: false, errorCode: 'machine_unavailable',
                details: { machineId: 'guest-builder', reason, status } });
        expect(acquire).not.toHaveBeenCalled();
    });
});
