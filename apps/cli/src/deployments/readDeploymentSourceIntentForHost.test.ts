import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1,
    type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { readDeploymentSourceIntentForHost } from './readDeploymentSourceIntentForHost';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';

afterEach(() => { withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); });

it('reads restore workspace rows under the signed public root while reading the Source under its own effect', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
    if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
    const native = projectDeploymentNativeAdmissionV1('deployments.backups.restore', { serverId: 'home',
        environmentId: environment.environment.id, machineId: 'controller', installationId: 'installation',
        targetLinkId: 'target', deploymentId: 'capture-receipt', restoreBackupId: 'backup', expectedRevision: 1, mode: 'prepare' });
    const effects: string[] = [];
    // Signing and HTTP are genuine boundaries; retain real Source/Account row admission beneath them.
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-restore', binding: {
        accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
        machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
        actionId: 'deployments.backups.restore', requestId: 'restore-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'controller' }, environmentId: environment.environment.id, deploymentNativeAdmission: native,
    } }), requesterAccountProjection: { accountId: 'owner', serverId: 'home', accountEncryptionMode: 'plain',
        projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain' }), isCurrent: async () => true, readArtifact: async () => null },
        requesterHttpProjection: { accountId: 'owner', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
            accountEncryptionMode: 'plain', isCurrent: async () => true, async createRequestHeaders(request) {
                effects.push(request.effectActionId);
                const admitted = request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                    ? request.effectActionId === 'deployments.backups.restore' : request.effectActionId === 'projects.sources.read';
                return admitted ? { 'x-requester-proof': 'restore' } : null;
            } },
    } satisfies ExternalActionExecutionAuthorizationV1;
    mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'home',
        machineId: 'controller', rootPath: '/restore-source', createdAtMs: 1,
        source: { sourceId: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision } })]);
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({ ok: true,
        canManage: true, source: { id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App', audience: [],
            createdByAccountId: 'owner', repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub',
                baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } }) });
    const context = { authority: 'present_user' as const, externalActionExecutionAuthorization: authorization,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller',
            installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => true };
    const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
    const selected = await readDeploymentSourceIntentForHost({ request: { environment, sourceIntent, actionId: 'deployments.rollback', context },
        host: { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'controller', async assertAuthority() {}, async resolveRequesterIdentity(current) {
                const requester = await identityOwner.resolveActionRequester!(current);
                try { return requester.identity; } finally { await requester.dispose(); }
            } } });
    expect(selected.workspace?.rootPath).toBe('/restore-source');
    expect(effects).toEqual(['projects.sources.read', 'deployments.backups.restore']);
});
