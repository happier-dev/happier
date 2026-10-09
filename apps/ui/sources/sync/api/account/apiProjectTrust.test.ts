import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import type { ProjectAccountRowsSnapshot } from '@/sync/store/domains/projectAccountRows';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

// The Machine RPC transport is a network boundary; the observation reader, Trust API and Account
// admission beneath it remain real.
const machineTransport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineTransport.read(...args),
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// The real Sync/Node-require bridge belongs in collection; cold graph loading is not a behavior deadline.
await loadSyncSingletonForTests();
let scope: { serverId: string; accountId: string };
const project = { serverId: 'project-home', projectId: 'project' };
const value = { project, reviewedEffectDigest: 'private-reviewed-effect', approvedAtMs: 19 };
const readPath = `${PROJECT_TRUST_ROUTE_V1}/read`;
const mutatePath = `${PROJECT_TRUST_ROUTE_V1}/mutate`;
const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
const randomBytes = (size: number) => new Uint8Array(size).fill(9);
function encrypted(payload: unknown, kind: 'project_setup_trust' | 'account_profile_record' = 'project_setup_trust') {
    return { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind, material, payload, randomBytes }) };
}
beforeEach(async () => {
    machineTransport.read.mockReset();
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Trust Home', serverUrl: 'https://trust-api.test', accountId: 'approver', active: false });
    scope = { serverId, accountId: 'approver' };
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, readPath, { body: { status: 'present', revision: 4, content: { t: 'plain', v: value } } });
    homes.answer(serverId, mutatePath, { body: { status: 'updated', revision: 5, cursor: 1 } });
});
afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

// Dynamic import keeps the existing Action-owner RED runnable before this new API producer lands.
describe('Project Trust captured UI Account API', () => {
    it('remembers only the captured Account’s currently accepted exact checkout, not another Account’s rows or a moved root', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { rememberProjectSetupConsent } = await import('@/components/projects/projectSetup/projectSetupConsentDecision');
        const workspace = { id: 'accepted', serverId: scope.serverId, machineId: 'machine', rootPath: '/checkout', projectKey: 'project', createdAtMs: 1 };
        const address = { serverId: workspace.serverId, workspaceId: workspace.id, machineId: workspace.machineId, rootPath: workspace.rootPath };
        const rows = { scope, status: 'ready', coverage: 'complete', workspaceRefs: [workspace], relationships: [], organizations: [], revisionsByPhysicalKey: {} } satisfies ProjectAccountRowsSnapshot;
        homes.answer(scope.serverId, readPath, { body: { status: 'absent' } });
        for (const snapshot of [
            { ...rows, scope: { ...scope, accountId: 'other-account' } },
            { ...rows, workspaceRefs: [{ ...workspace, rootPath: '/moved-checkout' }] },
        ]) {
            storage.setState({ profileScope: scope, projectAccountRows: snapshot });
            expect(await rememberProjectSetupConsent({ scope, workspace: address, reviewedEffectDigest: value.reviewedEffectDigest }))
                .toEqual({ kind: 'unavailable', code: 'project_unavailable' });
            expect(homes.requestsFor(readPath)).toEqual([]);
            expect(homes.requestsFor(mutatePath)).toEqual([]);
        }
        storage.setState({ profileScope: scope, projectAccountRows: rows });
        const operation = heldOperation(scope, address, value.reviewedEffectDigest);
        machineTransport.read.mockResolvedValueOnce({ kind: 'found', operation: operation.snapshot })
            .mockResolvedValueOnce({ kind: 'found', operation: { ...operation.snapshot, setupReview: undefined,
                domainRef: { ...operation.snapshot.domainRef!, cwd: '/worker-checkout/setup-subdirectory' } } });
        expect(await rememberProjectSetupConsent({ scope, workspace: address, operation, reviewedEffectDigest: value.reviewedEffectDigest }))
            .toEqual({ kind: 'remembered' });
        expect(homes.requestsFor(mutatePath).map(request => ProjectTrustMutationRequestV1Schema.parse(request.input)))
            .toEqual([{ project: { serverId: workspace.serverId, projectId: 'project' }, expectedRevision: 'absent',
                content: { t: 'plain', v: { project: { serverId: workspace.serverId, projectId: 'project' },
                    reviewedEffectDigest: value.reviewedEffectDigest, approvedAtMs: expect.any(Number) } } }]);
    });
    it('remembers the retained review through a registered Source Home alias without accepting an unknown Home', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { rememberProjectSetupConsent } = await import('@/components/projects/projectSetup/projectSetupConsentDecision');
        // Home-published identities use the protocol's srv_ shape; the real profile owner retains
        // the device-local URL id as an alias of this portable Home identity.
        const alias = await homes.addHome({ name: 'Alias Trust Home', serverUrl: 'https://alias-trust.test',
            serverIdentityId: 'srv_trust_home_identity', accountId: 'approver' });
        const serverId = resolveServerProfileScopeIdForIdentifier(alias);
        expect(alias).not.toBe(serverId);
        const captured = { serverId, accountId: 'approver' };
        const workspace = { serverId: alias, workspaceId: 'accepted-alias', machineId: 'source', rootPath: '/checkout' };
        const canonicalWorkspace = { ...workspace, serverId };
        storage.setState({ profileScope: captured, projectAccountRows: {
            scope: captured, status: 'ready', coverage: 'complete', workspaceRefs: [{ id: workspace.workspaceId,
                serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, projectKey: 'project', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {},
        } });
        const operation = heldOperation(captured, canonicalWorkspace, value.reviewedEffectDigest);
        expect(await rememberProjectSetupConsent({ scope: captured, workspace: { ...workspace, serverId: 'unknown-home' },
            operation, reviewedEffectDigest: value.reviewedEffectDigest })).toEqual({ kind: 'unavailable', code: 'project_unavailable' });
        expect(machineTransport.read).not.toHaveBeenCalled();
        homes.answer(alias, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(alias, readPath, { body: { status: 'absent' } });
        homes.answer(alias, mutatePath, { body: { status: 'updated', revision: 1, cursor: 1 } });
        machineTransport.read.mockResolvedValueOnce({ kind: 'found', operation: operation.snapshot })
            .mockResolvedValueOnce({ kind: 'found', operation: { ...operation.snapshot, setupReview: undefined } });
        expect(await rememberProjectSetupConsent({ scope: captured, workspace, operation, reviewedEffectDigest: value.reviewedEffectDigest }))
            .toEqual({ kind: 'remembered' });
        expect(homes.requestsFor(mutatePath).map(request => ProjectTrustMutationRequestV1Schema.parse(request.input)))
            .toEqual([{ project: { serverId, projectId: 'project' }, expectedRevision: 'absent',
                content: { t: 'plain', v: { project: { serverId, projectId: 'project' },
                    reviewedEffectDigest: value.reviewedEffectDigest, approvedAtMs: expect.any(Number) } } }]);
        expect(workspace.serverId).toBe(alias);
    });
    it('remeasures the retained target review before replacing Trust, including an already matching grant', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { rememberProjectSetupConsent } = await import('@/components/projects/projectSetup/projectSetupConsentDecision');
        const workspace = { serverId: scope.serverId, workspaceId: 'accepted', machineId: 'source', rootPath: '/checkout' };
        storage.setState({ profileScope: scope, projectAccountRows: {
            scope, status: 'ready', coverage: 'complete', workspaceRefs: [{ id: 'accepted', serverId: scope.serverId,
                machineId: 'source', rootPath: '/checkout', projectKey: 'project', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {},
        } });
        const operation = heldOperation(scope, workspace, value.reviewedEffectDigest);
        homes.answer(scope.serverId, readPath, { body: { status: 'present', revision: 4, content: {
            t: 'plain', v: { ...value, project: { serverId: scope.serverId, projectId: 'project' } },
        } } });
        machineTransport.read.mockResolvedValue({ kind: 'found', operation: {
            ...operation.snapshot, setupReview: { ...operation.snapshot.setupReview!, reviewedEffectDigest: 'changed-on-worker' },
        } });
        expect(await rememberProjectSetupConsent({ scope, workspace, operation, reviewedEffectDigest: value.reviewedEffectDigest }))
            .toEqual({ kind: 'changed' });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
        expect(homes.requestsFor(readPath)).toEqual([]);
        expect(machineTransport.read.mock.calls[0]?.[0]).toMatchObject({ machineId: 'target', serverId: scope.serverId,
            accountId: scope.accountId, payload: { operationId: 'held-operation' } });
    });
    it('does not replace consent without a current review producer, and does not report Allowed after continuation reholds', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { rememberProjectSetupConsent } = await import('@/components/projects/projectSetup/projectSetupConsentDecision');
        const workspace = { serverId: scope.serverId, workspaceId: 'accepted', machineId: 'source', rootPath: '/checkout' };
        storage.setState({ profileScope: scope, projectAccountRows: {
            scope, status: 'ready', coverage: 'complete', workspaceRefs: [{ id: 'accepted', serverId: scope.serverId,
                machineId: 'source', rootPath: '/checkout', projectKey: 'project', createdAtMs: 1 }],
            relationships: [], organizations: [], revisionsByPhysicalKey: {},
        } });
        expect(await rememberProjectSetupConsent({ scope, workspace, reviewedEffectDigest: value.reviewedEffectDigest }))
            .toEqual({ kind: 'unavailable', code: 'project_setup_requester_review_unavailable' });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
        const operation = heldOperation(scope, workspace, value.reviewedEffectDigest);
        homes.answer(scope.serverId, readPath, { body: { status: 'absent' } });
        for (const snapshot of [
            { ...operation.snapshot, scope: { ...operation.snapshot.scope, accountId: 'custodian' } },
            { ...operation.snapshot, domainRef: { ...operation.snapshot.domainRef!, cwd: '/different-worker-checkout' } },
            { ...operation.snapshot, domainRef: { ...operation.snapshot.domainRef!, sourceWorkspace: { ...workspace, rootPath: '/different-checkout' } } },
            { ...operation.snapshot, domainRef: { ...operation.snapshot.domainRef!, sourceWorkspace: undefined } },
        ]) {
            machineTransport.read.mockResolvedValue({ kind: 'found', operation: snapshot });
            expect(await rememberProjectSetupConsent({ scope, workspace, operation, reviewedEffectDigest: value.reviewedEffectDigest }))
                .toEqual({ kind: 'unavailable', code: 'project_setup_review_unavailable' });
            expect(homes.requestsFor(readPath)).toEqual([]);
            expect(homes.requestsFor(mutatePath)).toEqual([]);
        }
        homes.answer(scope.serverId, readPath, { body: { status: 'absent' } });
        machineTransport.read.mockResolvedValueOnce({ kind: 'found', operation: operation.snapshot })
            .mockResolvedValueOnce({ kind: 'found', operation: { ...operation.snapshot,
                setupReview: { ...operation.snapshot.setupReview!, reviewedEffectDigest: 'changed-after-write' } } });
        expect(await rememberProjectSetupConsent({ scope, workspace, operation, reviewedEffectDigest: value.reviewedEffectDigest }))
            .toEqual({ kind: 'changed' });
        expect(homes.requestsFor(mutatePath)).toHaveLength(1);
    });
    it('reads and remembers a complete plain value with token-only credentials, exact CAS and no settings writes', async () => {
        const api = await import('./apiProjectTrust');
        expect(await api.readProjectTrust(scope, project)).toEqual({ status: 'present', revision: 4, value });
        expect(await api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: value.reviewedEffectDigest, expectedRevision: 4 }))
            .toEqual({ status: 'updated', revision: 5, cursor: 1 });
        expect(homes.requestsFor(mutatePath).map(row => ProjectTrustMutationRequestV1Schema.parse(row.input)))
            .toEqual([{ project, expectedRevision: 4, content: { t: 'plain', v: value } }]);
        expect(homes.requestsFor('/v2/account/settings')).toEqual([]);
    });
    it('refuses changed review, wrong captured Account, and human-only route denial without a caller authority flag', async () => {
        const api = await import('./apiProjectTrust');
        await expect(api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: 'new-effect', expectedRevision: 4 }))
            .rejects.toMatchObject({ code: 'project_setup_effect_changed' });
        await expect(api.readProjectTrust({ ...scope, accountId: 'custodian' }, project)).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(homes.requestsFor(mutatePath)).toEqual([]);
        homes.answer(scope.serverId, mutatePath, { status: 403, body: { error: 'present_user_required' } });
        await expect(api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: value.reviewedEffectDigest, expectedRevision: 4 }))
            .rejects.toMatchObject({ code: 'present_user_required' });
    });
    it('keeps E2EE opaque, opens only purpose36 bound to the exact qualified Project, and rejects a different valid purpose', async () => {
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://trust-api.test', { serverId: scope.serverId });
        if (!credentials) throw new Error('Missing boundary credentials');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: credentials.token, secret: Buffer.from(material.secret).toString('base64url') });
        homes.answer(scope.serverId, '/v1/account/encryption', { body: { mode: 'e2ee', updatedAt: 1 } });
        const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
        homes.answer(scope.serverId, '/v1/account/encryption/currentness', { body: { ...createPlainAccountEncryptionCurrentnessFixture(), mode: 'e2ee', contentKeyFingerprint,
            recipientEnvelopeReadiness: { status: 'available' } } });
        homes.answer(scope.serverId, readPath, { body: { status: 'present', revision: 4, content: encrypted(value) } });
        const api = await import('./apiProjectTrust');
        expect(await api.readProjectTrust(scope, project)).toEqual({ status: 'present', revision: 4, value });
        await api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: value.reviewedEffectDigest, expectedRevision: 4 });
        const mutation = ProjectTrustMutationRequestV1Schema.parse(homes.requestsFor(mutatePath)[0]?.input);
        expect(JSON.stringify(mutation)).not.toContain(value.reviewedEffectDigest);
        if (mutation.content?.t !== 'encrypted') throw new Error('Expected Account ciphertext');
        expect(openAccountScopedBlobCiphertext({ kind: 'project_setup_trust', material, ciphertext: mutation.content.c })?.value).toEqual(value);
        for (const content of [encrypted({ ...value, project: { ...project, serverId: 'other-home' } }), encrypted(value, 'account_profile_record')]) {
            homes.answer(scope.serverId, readPath, { body: { status: 'present', revision: 4, content } });
            await expect(api.readProjectTrust(scope, project)).rejects.toMatchObject({ code: expect.stringMatching(/project_trust_(identity_mismatch|content_mode_mismatch)/u) });
        }
    });
    it('fails closed on incompatible Account content, missing E2EE material and unavailable storage before disclosure', async () => {
        const api = await import('./apiProjectTrust');
        homes.answer(scope.serverId, readPath, { body: { status: 'present', revision: 4, content: encrypted(value) } });
        await expect(api.readProjectTrust(scope, project)).rejects.toMatchObject({ code: 'project_trust_content_mode_mismatch' });
        homes.answer(scope.serverId, readPath, { status: 503, body: { error: 'project_trust_storage_unavailable', reason: 'account-mode-mismatch' } });
        await expect(api.readProjectTrust(scope, project)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        homes.answer(scope.serverId, '/v1/account/encryption', { body: { mode: 'e2ee', updatedAt: 1 } });
        await expect(api.readProjectTrust(scope, project)).rejects.toMatchObject({ code: 'project_trust_encryption_material_unavailable' });
    });
    it('does not expose credential-bearing native HTTP errors through public read or Remember failures', async () => {
        const api = await import('./apiProjectTrust');
        const token = 'private-native-transport-bearer';
        const nativeFailure = () => { throw Object.assign(new Error(`Native HTTP failure ${token}`), { config: { headers: { Authorization: `Bearer ${token}` } } }); };
        // These are genuine HTTP boundaries; Account capture, mode and mutation classification remain real.
        homes.answer(scope.serverId, '/v1/account/encryption/currentness', { select: nativeFailure });
        const readError: unknown = await api.readProjectTrust(scope, project).catch((error: unknown) => error);
        expect(readError).toMatchObject({ code: 'project_trust_encryption_material_unavailable' });
        expect(JSON.stringify(readError)).not.toContain(token);
        expect(readError).not.toHaveProperty('cause');
        homes.answer(scope.serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(scope.serverId, mutatePath, { select: nativeFailure });
        const writeError: unknown = await api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: value.reviewedEffectDigest, expectedRevision: 4 })
            .catch((error: unknown) => error);
        expect(writeError).toMatchObject({ code: 'outcome_unknown' });
        expect(JSON.stringify(writeError)).not.toContain(token);
        expect(writeError).not.toHaveProperty('cause');
        homes.answer(scope.serverId, readPath, { select: nativeFailure });
        const transportReadError: unknown = await api.readProjectTrust(scope, project).catch((error: unknown) => error);
        expect(transportReadError).toMatchObject({ code: 'project_trust_storage_unavailable' });
        expect(JSON.stringify(transportReadError)).not.toContain(token);
        expect(String(transportReadError)).not.toContain(token);
    });
    it('retains an unknown write outcome for an empty or malformed successful receipt without automatically replaying Remember', async () => {
        const api = await import('./apiProjectTrust');
        for (const body of [undefined, { status: 'updated', revision: 'not-a-revision', cursor: 1 }]) {
            const before = homes.requestsFor(mutatePath).length;
            homes.answer(scope.serverId, mutatePath, { status: 200, ...(body === undefined ? {} : { body }) });
            const error: unknown = await api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: value.reviewedEffectDigest, expectedRevision: 4 })
                .catch((error: unknown) => error);
            expect(error).toMatchObject({ code: 'outcome_unknown' });
            expect(error).not.toHaveProperty('cause');
            expect(homes.requestsFor(mutatePath)).toHaveLength(before + 1);
        }
    });
    it('withdraws a late private read after credential retirement but preserves an acknowledged mutation receipt at the captured Home', async () => {
        const api = await import('./apiProjectTrust');
        let release: (() => void) | undefined;
        let started!: () => void;
        const issued = new Promise<void>(resolve => { started = resolve; });
        homes.answer(scope.serverId, readPath, { select: () => { started(); return { body: { status: 'present', revision: 4, content: { t: 'plain', v: value } }, respondAfter: new Promise<void>(resolve => { release = resolve; }) }; } });
        // Handle either result immediately: an early capture failure must fail this test,
        // not leave a rejected assertion detached while waiting for a never-issued HTTP request.
        const readResult = api.readProjectTrust(scope, project).then(
            result => ({ status: 'resolved' as const, result }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        try {
            await Promise.race([issued, readResult.then(result => {
                if (result.status === 'rejected') throw result.error;
                throw new Error('Private read unexpectedly settled before its held HTTP response');
            })]);
            await homes.switchAccount(scope.serverId, 'replacement');
        } finally { release?.(); }
        expect(await readResult).toMatchObject({ status: 'rejected', error: { code: 'action_account_scope_changed' } });
        scope = { ...scope, accountId: 'replacement' };
        homes.answer(scope.serverId, mutatePath, { select: () => {
            return { body: { status: 'updated', revision: 5, cursor: 1 }, respondAfter: homes.switchAccount(scope.serverId, 'third-account') };
        } });
        expect(await api.rememberReviewedProjectEffect(scope, { ...value, currentEffectDigest: value.reviewedEffectDigest, expectedRevision: 4 }))
            .toEqual({ status: 'updated', revision: 5, cursor: 1 });
    });
});

function heldOperation(scope: { serverId: string; accountId: string }, sourceWorkspace: {
    serverId: string; workspaceId: string; machineId: string; rootPath: string;
}, reviewedEffectDigest: string) {
    const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'held-operation', revision: 1,
        actionId: 'projects.script.run', state: 'accepted', scope: { accountId: scope.accountId, machineId: 'target' },
        title: 'Script', createdAt: 1, cancellation: 'supported',
        domainRef: { kind: 'projectCommand', purpose: 'script', serverId: scope.serverId, machineId: 'target',
            workspaceRefId: 'target-workspace', cwd: '/worker-checkout', sourceWorkspace },
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest,
            reviewedEffect: { commands: ['install'] } },
    };
    return { serverId: scope.serverId, snapshot };
}
