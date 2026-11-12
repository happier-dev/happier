import axios from 'axios';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactReadBatchHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
    AccountApiTokenSummaryV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1,
    createDeploymentSecretVariableBindingV1, createDeploymentTargetLinkHeaderV1, createDeploymentReceiptDetailV1,
    createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { openEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { MachineAccessGrantSetInputV1Schema, MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import { createWorkflowAutomationDetailFixture, createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { WorkflowApprovedOperationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { AutomationStoredWorkflowDefinitionV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretCreateInputV1Schema, SavedSecretResourceEnvelopeRepairInputV1Schema,
    SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { DeploymentBindingsSetInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { ProjectSourcesUpdateInputV1Schema, ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import nacl from 'tweetnacl';

// Only the network, device credential store and disconnected socket boundary
// are replaced. Account capture, settings, admission and Source dispatch stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
const { ArtifactEncryption } = await import('@/sync/encryption/artifactEncryption');
const { openArtifactPrivateRevisionMetadata } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
let restoreScopedMovePolicy: (() => void) | undefined;

/** Drive the mounted UI's native review through the real Account Action host. */
function executeReviewedMove(input: unknown,
    review: NonNullable<NonNullable<Parameters<typeof createDefaultActionExecutor>[0]>['presentUserActionConfirmation']>,
) {
    return createDefaultActionExecutor({ presentUserActionConfirmation: review })
        .execute('projects.sources.moveToTeam', input, { surface: 'ui', authority: 'present_user' });
}

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => {
    restoreScopedMovePolicy?.();
    restoreScopedMovePolicy = undefined;
    const { resetSavedSecretCatalogEngineForTests } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
    resetSavedSecretCatalogEngineForTests();
    await homes.reset();
});

function answerMoveDefaults(serverId: string, sourceId: string, sourceRevision: number) {
    homes.answer(serverId, `GET /v1/projects/${sourceId}/deployment-defaults`, { body:
        ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: sourceId,
            sourceRevision, revision: 0, content: null }) });
}

function answerMoveMachine(serverId: string, machineId: string) {
    homes.answer(serverId, `GET /v1/machines/${machineId}/access`, { body: MachineAccessGrantsListResponseV1Schema.parse({
        machineId, custodian: { accountId: 'account-owner', displayName: 'Owner' },
        access: { custodian: { accountId: 'account-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
}

function answerMoveEncryptedCurrentness(serverId: string, secret: Uint8Array) {
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
    } });
}

async function requireMoveReview(serverId: string, secret?: Uint8Array) {
    await homes.requireUiApproval(serverId, 'projects.sources.moveToTeam');
    if (secret) homes.answer(serverId, '/v2/account/settings', { body: { version: 2, content: { t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: { type: 'legacy', secret },
            payload: { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'projects.sources.moveToTeam': { approvalRequiredSurfaces: ['ui'] },
            } }) }, randomBytes: nacl.randomBytes }),
    } } });
}

async function openMoveScenario(options: Readonly<{ failure?: 'source-conflict' | 'token-unknown' | 'grant-pending' | 'secret-preparation-pending';
    mode?: 'plain' | 'e2ee'; scopedRequire?: boolean; reviewPolicy?: 'default' | 'waived' }> = {}) {
    const mode = options.mode ?? (options.failure === 'secret-preparation-pending' ? 'e2ee' : 'plain');
    const accountSecret = new Uint8Array(32).fill(11);
    const serverIdentityId = 'srv_composed_move';
    const serverId = await homes.addHome({ name: 'Composed Move', serverUrl: 'https://composed-source-move.test',
        serverIdentityId, accountId: 'account-owner', currentAccount: true, accountEncryptionMode: mode,
        ...(mode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }),
            secret: encodeBase64(accountSecret, 'base64url') } } : {}),
    });
    if (mode === 'e2ee') answerMoveEncryptedCurrentness(serverId, accountSecret);
    let source = ProjectSourceV1Schema.parse({ id: 'source-app', revision: 4, name: 'App', createdByAccountId: 'account-owner',
        owner: { kind: 'account', accountId: 'account-owner' }, audience: [
            { principal: { kind: 'account', accountId: 'account-owner' }, level: 'view' },
            { principal: { kind: 'account', accountId: 'unrelated-reader' }, level: 'view' },
        ] });
    const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId }) });
    const binding = createDeploymentSecretVariableBindingV1({ name: 'PASSWORD', phase: 'runtime', resourceId: 'original', resourceRevision: 2 });
    detail.content.bindings = [binding];
    const effects: string[] = [];
    const preparedArtifactIds = new Set<string>();
    const preparedSecretIds = new Set<string>();
    homes.answer(serverId, '/v1/projects/sources/source-app', { select: () => ({ body: { ok: true, source, canManage: true } }) });
    homes.answer(serverId, 'PATCH /v1/projects/sources/source-app', { select: raw => {
        const input = ProjectSourcesUpdateInputV1Schema.parse(raw);
        effects.push(input.patch.owner ? 'source-owner' : 'source-audience');
        if (options.failure === 'source-conflict') return { body: { ok: false, error: 'source_conflict', current: source } };
        expect(input.expectedRevision).toBe(source.revision);
        if (input.patch.owner) {
            expect(effects).toContain('bindings');
            expect(detail.environment.contentArtifactId).not.toBe('artifact-environment');
            expect(homes.artifacts(serverId).readGrants(detail.environment.contentArtifactId)).toContainEqual(expect.objectContaining({
                principal: { kind: 'team', teamId: 'team' }, accessLevel: 'admin',
            }));
            if (mode === 'e2ee') expect(preparedArtifactIds.has(detail.environment.contentArtifactId)).toBe(true);
        } else {
            expect(effects).toContain('token-child');
            expect(effects).toContain('trigger');
        }
        source = ProjectSourceV1Schema.parse({ ...source, ...input.patch, revision: source.revision + 1 });
        detail.environment.owner = source.owner!;
        return { body: { ok: true, source, canManage: true } };
    } });
    answerMoveDefaults(serverId, source.id, source.revision);
    homes.answer(serverId, '/v1/deployments/environments', { select: (_raw, request) => {
        expect(new URL(request.url).searchParams.get('includeDeleted')).toBe('true');
        return { body: { ok: true, items: [detail.environment], nextCursor: null } };
    } });
    homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { select: (_raw, request) => {
        // Inventory opts in; the canonical bindings and approval-scope owners also
        // use this same ordinary GET without requesting retained cleanup facts.
        const cleanupRequested = new URL(request.url).searchParams.get('includeRetainedTargetLinkCleanup') === 'true';
        return { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        ...(cleanupRequested ? { retainedTargetLinkCleanupCompleteIds: [] } : {}),
    } }; } });
    homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}/deployments`, { body: { ok: true, items: [], nextCursor: null } });
    const custodian = { accountId: 'other-machine-owner', displayName: 'Machine owner' };
    homes.answer(serverId, 'GET /v1/machines/machine-a/access', { body: MachineAccessGrantsListResponseV1Schema.parse({
        machineId: 'machine-a', custodian, access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        canManage: true, grants: [{ machineId: 'machine-a', principal: { kind: 'account', accountId: 'account-owner' }, level: 'admin',
            display: { name: 'Owner' }, readiness: 'ready', audience: [{ accountId: 'account-owner', displayName: 'Owner',
                readiness: 'ready', reason: null, canPrepareKeys: false }], removal: { losesAccessAccountIds: ['account-owner'] } }],
        ownDirectGrant: true, ownAccessSources: [{ principal: { kind: 'account', accountId: 'account-owner' }, displayName: 'Owner' }],
    }) });
    homes.answer(serverId, 'PUT /v1/machines/machine-a/access', { select: raw => {
        const input = MachineAccessGrantSetInputV1Schema.parse({ serverId, machineId: 'machine-a',
            ...(raw && typeof raw === 'object' ? raw : {}) });
        effects.push('machine-team');
        return { body: { kind: 'saved', grant: { machineId: input.machineId, principal: input.principal, level: input.level },
            readiness: options.failure === 'grant-pending' ? 'key_pending' : 'ready', canPrepareKeys: false } };
    } });
    homes.answer(serverId, 'DELETE /v1/machines/machine-a/access', { select: () => {
        effects.push('machine-withdraw');
        expect(effects).toContain('token-child');
        expect(effects).toContain('trigger');
        return { body: { kind: 'removed', effectiveAccess: 'manage' } };
    } });
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const writer = await captureLazyActionAccountContext(serverId);
    const scope = writer.accountLifetime.scope;
    const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials(writer.credentials) : null;
    try {
        await writer.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }, body: JSON.stringify(detail.content) });
        for (const link of detail.targetLinks) await writer.createArtifactDocument({ artifactId: link.targetLink.contentArtifactId,
            header: { kind: 'deployment-target-link.v1', title: 'Target' }, body: JSON.stringify(link.content) });
    } finally { writer.dispose(); }
    const teamKey = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(54));
    const teamFingerprint = computeContentPublicKeyFingerprint(teamKey.publicKey);
    if (mode === 'e2ee' && options.failure !== 'secret-preparation-pending') {
        // This HTTP fixture extends the existing Artifact persistence boundary
        // with a real Team audience and committed recipient envelopes.
        const artifacts = homes.artifacts(serverId);
        const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(53));
        const recipient = { recipientAccountId: 'team-member', contentKey: { status: 'available' as const,
            accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(teamKey.publicKey),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                contentPublicKey: teamKey.publicKey })) }, contentPublicKeyFingerprint: teamFingerprint };
        const envelopes = new Map<string, ReturnType<typeof ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse>['recipientKeyEnvelopes'][number]>();
        const serveCommit = (artifactId: string) => homes.answer(serverId, `POST /v1/artifacts/${artifactId}/access/key-envelopes`, { select: async raw => {
            const input = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse(raw);
            const envelope = input.recipientKeyEnvelopes[0]!;
            expect(input.recipientKeyEnvelopes).toHaveLength(1);
            expect(envelope.recipientAccountId).toBe('team-member');
            const dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope.encryptedDataKey),
                recipientSecretKeyOrSeed: teamKey.secretKey });
            const provenanceKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope.encryptedProvenanceDataKey!),
                recipientSecretKeyOrSeed: teamKey.secretKey });
            const artifact = artifacts.read(artifactId)!;
            expect(await new ArtifactEncryption(dataKey!).decryptBody(artifact.body!)).toMatchObject({ body: expect.any(String) });
            expect(await openArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId, bodyVersion: artifact.bodyVersion!,
                provenance: artifact.provenance, dataKey: provenanceKey })).toMatchObject({ savedBy: { kind: 'person', accountId: 'account-owner' } });
            envelopes.set(artifactId, envelope);
            preparedArtifactIds.add(artifactId);
            return { body: { appliedRecipientAccountIds: ['team-member'], skippedRecipientAccountIds: [] } };
        } });
        artifacts.list().forEach(artifact => serveCommit(artifact.id));
        homes.answer(serverId, 'POST /v1/artifacts', { select: async (_raw, request) => {
            const response = await artifacts.handle('/v1/artifacts', request.init);
            if (!response) throw new Error('Expected the existing Artifact creation boundary');
            const body: unknown = await response.json();
            if (body && typeof body === 'object' && 'id' in body && typeof body.id === 'string') serveCommit(body.id);
            return { status: response.status, body };
        } });
        homes.answer(serverId, 'POST /v1/artifacts/read', { select: async raw => {
            const response = createArtifactReadBatchHttpResponse(raw, artifactId => {
                const artifact = artifacts.read(artifactId);
                if (!artifact) return { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
                const envelope = envelopes.get(artifactId);
                const teamGranted = artifacts.readGrants(artifactId).some(grant => grant.principal.kind === 'team' && grant.principal.teamId === 'team');
                return { artifactId, ok: true, artifact, recipientCensus: { artifactId, ownerAccountId: 'account-owner', access: 'owner',
                    encryptionMode: 'e2ee', dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey,
                    provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey, callerProvenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey,
                    recipients: teamGranted ? [{ ...recipient, encryptedDataKey: envelope?.encryptedDataKey ?? null,
                        encryptedProvenanceDataKey: envelope?.encryptedProvenanceDataKey ?? null,
                        recipientContentPublicKeyFingerprint: envelope?.recipientContentPublicKeyFingerprint ?? null }] : [] } };
            });
            return { body: await response.json() };
        } });
    }
    const materials = new Map<string, ReturnType<typeof SavedSecretResourceMaterialsResponseV1Schema.parse>['resources'][number]>();
    const material = (resourceId: string, storedContent: unknown, revision: number, key?: Uint8Array) => SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
        resourceId, encryptionMode: mode, storedContent,
        recipientEnvelope: key ? { encryptedDataKey: encryptDataKeyForRecipientV0(key,
            encodeBase64(encryption!.contentDataKey, 'base64')),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption!.contentDataKey) } : null,
        entry: {
            ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship: 'owner', ownerAccountId: 'account-owner',
            name: 'Password', kind: 'token', revision, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        },
    }] }).resources[0]!;
    const content = { v: 1 as const, name: 'Password', kind: 'token' as const, value: 'move-secret-sentinel' };
    const resourceKey = mode === 'e2ee' ? new Uint8Array(32).fill(13) : undefined;
    const original = material('original', mode === 'plain'
        ? sealSavedSecretResourceStoredContentV1({ resourceId: 'original', mode, content })
        : sealSavedSecretResourceStoredContentV1({ resourceId: 'original', mode, resourceDataKey: resourceKey!,
            content, randomBytes: nacl.randomBytes }), 2, resourceKey);
    materials.set('original', original);
    homes.answer(serverId, '/v1/account/saved-secrets/resources/materials', { select: (_raw, request) => {
        const id = new URL(request.url).searchParams.get('resourceId');
        return { body: { resources: id && materials.has(id) ? [materials.get(id)] : [] } };
    } });
    homes.answer(serverId, SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'], { select: async raw => {
        const input = SharedSavedSecretCreateInputV1Schema.parse(raw);
        effects.push('secret-copy');
        expect(effects).toContain('machine-team');
        expect(input).toMatchObject({ teamGrants: ['team'], accountGrants: [], groupGrants: [] });
        const createdKey = encryption ? await encryption.decryptEncryptionKey(input.keyEnvelopes![0]!.encryptedDataKey, scope) : null;
        materials.set(input.resourceId, material(input.resourceId, input.storedContent, 1, createdKey ?? undefined));
        return { body: { resourceId: input.resourceId, revision: 1 } };
    } });
    if (mode === 'e2ee') {
        homes.answer(serverId, '/v1/account/saved-secrets/resources/envelope-census', options.failure === 'secret-preparation-pending'
            ? { status: 503, body: { error: 'temporarily_unavailable' } }
            : { select: (_raw, request) => {
                const resourceId = new URL(request.url).searchParams.get('resourceId');
                return { body: { resourceId, revision: 1, nextCursor: null, recipients: [{
                    account: { kind: 'account', accountId: 'team-member', firstName: 'Team member', lastName: null, username: null, avatarUrl: null },
                    readiness: { status: 'available', contentPublicKey: encodeBase64(teamKey.publicKey), contentPublicKeyFingerprint: teamFingerprint },
                    envelopeStatus: resourceId && preparedSecretIds.has(resourceId) ? 'prepared' : 'missing',
                }] } };
            } });
        homes.answer(serverId, 'POST /v1/account/saved-secrets/resources/envelopes/repair', { select: async raw => {
            const input = SavedSecretResourceEnvelopeRepairInputV1Schema.parse(raw);
            const stored = materials.get(input.resourceId)!;
            if (!('recipientEnvelope' in stored) || !stored.recipientEnvelope) throw new Error('Expected ready E2EE Secret material');
            const ownerKey = await encryption!.decryptEncryptionKey(stored.recipientEnvelope.encryptedDataKey, scope);
            expect(input.keyEnvelopes).toHaveLength(1);
            expect(input.keyEnvelopes[0]!.recipientAccountId).toBe('team-member');
            expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.keyEnvelopes[0]!.encryptedDataKey),
                recipientSecretKeyOrSeed: teamKey.secretKey })).toEqual(ownerKey);
            preparedSecretIds.add(input.resourceId);
            return { body: { resourceId: input.resourceId, revision: input.expectedRevision } };
        } });
    }
    // The canonical daemon HTTP boundary preserves the Account's plain/E2EE
    // codec; CLI composed tests own preparation beneath that remote boundary.
    await answerExternalActionAccountForHome(homes, serverId, {
        machineId: 'machine-a', actionId: 'deployments.bindings.set', tokenEpoch: 0,
        execute: async raw => {
            const input = DeploymentBindingsSetInputV1Schema.parse(raw);
            if (!('set' in input)) throw new Error('Expected authored Move bindings');
            expect(input.set).toHaveLength(1);
            const source = input.set[0]!.source;
            expect(source.kind).toBe('secret');
            if (source.kind !== 'secret') throw new Error('Expected copied Secret');
            expect(source.ref).not.toBe(binding.source.ref);
            const remoteAccount = await captureLazyActionAccountContext(serverId);
            let candidate: Awaited<ReturnType<typeof remoteAccount.createArtifactDocument>>;
            try {
                candidate = await remoteAccount.createArtifactDocument({ header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name },
                    body: JSON.stringify({ ...detail.content, bindings: input.set }) });
            } finally { remoteAccount.dispose(); }
            effects.push('bindings');
            detail.environment = { ...detail.environment, revision: input.expectedRevision + 1,
                contentArtifactId: candidate.artifactId, contentHeaderVersion: candidate.revision.headerVersion,
                contentBodyVersion: candidate.revision.bodyVersion };
            return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision,
                preparedArtifact: { contentArtifactId: candidate.artifactId, contentHeaderVersion: candidate.revision.headerVersion,
                    contentBodyVersion: candidate.revision.bodyVersion } };
        },
    });
    const token = (tokenId: string, parentTokenId: string | null) => AccountApiTokenSummaryV1Schema.parse({ tokenId, label: parentTokenId ? 'CI child' : 'CI root',
        displayPrefix: `hap_v1_${tokenId.slice(0, 8)}`, createdAt: '2026-08-22T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
        hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
        parentTokenId, activeChildCount: parentTokenId ? 0 : 1, embedConfig: null });
    const root = token('dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', null);
    const child = token('ee03e74b-4aae-4a0a-81ee-1c23ddc4525d', root.tokenId);
    homes.answer(serverId, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, { body: { tokens: [root, child] } });
    homes.answer(serverId, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, { select: raw => {
        const current = raw && typeof raw === 'object' && 'tokenId' in raw && raw.tokenId === child.tokenId ? child : root;
        effects.push(current.parentTokenId ? 'token-child' : 'token-root');
        expect(source.owner).toEqual({ kind: 'team', teamId: 'team' });
        if (options.failure === 'token-unknown' && current.parentTokenId) return { dispatchThenFail: true };
        return { body: { apiToken: { ...current, hasUnattendedTeamAccess: true } } };
    } });
    const workflow = createWorkflowAutomationHttpBoundary();
    const automationId = '11111111-1111-4111-8111-111111111111';
    const triggerId = '22222222-2222-4222-8222-222222222222';
    const stepInput = { serverId: serverIdentityId, environmentId: detail.environment.id, targetLinkId: detail.environment.runtimeTargetLinkId! };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'deploy', actionId: 'deployments.deploy',
        input: Object.fromEntries(Object.entries(stepInput).map(([key, value]) => [key, { kind: 'literal', value }])) }] });
    const fixture = createWorkflowAutomationDetailFixture({ id: automationId, revision: 1, triggerId, definition });
    if (fixture.executionRecipe?.v !== 2 || fixture.executionRecipe.workflow.t !== 'plain') throw new Error('Expected a plain Automation fixture');
    const workflowContext = AutomationStoredWorkflowDefinitionV2Schema.parse({
        ...AutomationStoredWorkflowDefinitionV2Schema.parse(fixture.executionRecipe.workflow.v), actionApprovals: [{ triggerId,
            operation: WorkflowApprovedOperationV1Schema.parse({ parent: { actionId: 'workflow.trigger.add', input: {} },
                approvedBy: { accountId: 'account-owner' }, steps: [{ actionId: 'deployments.deploy', input: stepInput }] }),
        }] });
    workflow.rows.set(automationId, AutomationDefinitionDetailSchema.parse({ ...fixture,
        assignments: fixture.assignments.map(assignment => ({ ...assignment, machineId: 'machine-a' })),
        executionRecipe: { ...fixture.executionRecipe,
        workflow: mode === 'e2ee' ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
            material: { type: 'legacy', secret: accountSecret }, payload: workflowContext, randomBytes: nacl.randomBytes }) }
            : { t: 'plain', v: workflowContext },
    } }));
    for (const [method, path] of [['POST', '/v3/automations/query'], ['GET', `/v3/automations/${automationId}`],
        ['PUT', `/v3/automations/${automationId}`], ['PATCH', `/v3/automations/${automationId}`]] as const) {
        homes.answer(serverId, `${method} ${path}`, { select: async (_raw, request) => {
            if (method === 'PUT' || method === 'PATCH') {
                effects.push('trigger');
                expect(source.owner).toEqual({ kind: 'team', teamId: 'team' });
            }
            const response = await workflow.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Unrecognized Automation boundary request');
            return { status: response.status, body: await response.json() };
        } });
    }
    if (options.scopedRequire) {
        // The harness retains cleanup custody for this real Account setting.
        await homes.setActionPolicy(serverId, ['deployments.bindings.set', 'projects.sources.moveToTeam'], 'ui', 'allowed');
        const policyAccount = await captureLazyActionAccountContext(serverId);
        try {
            const { loadAccountSettings, saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
            const prior = loadAccountSettings(policyAccount.accountLifetime.scope);
            const settings = await policyAccount.readSettings();
            const actionsSettingsV1 = setScopedActionApprovalPreference({ settings: settings.actionsSettingsV1,
                actionId: 'deployments.bindings.set', scope: { kind: 'environment', environmentId: detail.environment.id }, surface: 'ui', mode: 'required' });
            const scopedSettings = { ...settings, actionsSettingsV1 };
            const scope = policyAccount.accountLifetime.scope;
            if (prior.version === null) throw new Error('Expected the fixture Account policy baseline');
            const priorVersion = prior.version;
            restoreScopedMovePolicy = () => saveAccountSettings(scope, settings, priorVersion);
            saveAccountSettings(scope, scopedSettings, priorVersion + 1);
            homes.answer(serverId, '/v2/account/settings', { body: { version: priorVersion + 1,
                content: mode === 'e2ee' ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: { type: 'legacy', secret: accountSecret }, payload: scopedSettings, randomBytes: nacl.randomBytes }) }
                    : { t: 'plain', v: scopedSettings } } });
            // The host's actual captured Account, not the globally focused
            // storage snapshot, must observe the exact scoped Require row.
            expect((await policyAccount.readSettings()).actionsSettingsV1).toEqual(actionsSettingsV1);
        } finally { policyAccount.dispose(); }
    } else if (options.reviewPolicy === 'waived') await homes.setActionPolicy(serverId, 'projects.sources.moveToTeam', 'ui', 'allowed');
    else if (options.reviewPolicy !== 'default') await requireMoveReview(serverId, mode === 'e2ee' ? accountSecret : undefined);
    return { serverId, detail, binding, effects, materials, original, workflow, preparedArtifactIds, preparedSecretIds, source: () => source,
        originalArtifactIds: [detail.environment.contentArtifactId, ...detail.targetLinks.map(link => link.targetLink.contentArtifactId)],
        input: { serverId, sourceId: source.id, expectedRevision: source.revision, teamId: 'team', requestKey: 'composed-move' } };
}

describe('Source admission through the default Account Action host', () => {
    it.each(['saved', 'retired', 'unknown'] as const)('retains the captured background Account for CI renewal (%s)', async outcome => {
        const serverId = await homes.addHome({ name: 'CI workload Home', serverUrl: 'https://ci-workload.test',
            accountId: 'workload-account', currentAccount: true, active: false });
        await homes.addHome({ name: 'Focused CI Home', serverUrl: 'https://ci-focused.test',
            accountId: 'focused-account', currentAccount: true });
        const token = AccountApiTokenSummaryV1Schema.parse({ tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'CI deploy',
            displayPrefix: 'hap_v1_dd03e74b', createdAt: '2026-08-22T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
            hasEncryptionAccess: false, hasUnattendedTeamAccess: true, grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null, activeChildCount: 0, embedConfig: null });
        homes.answer(serverId, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, outcome === 'unknown'
            ? { dispatchThenFail: true } : { body: { apiToken: token } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { updateCurrentAccountApiToken } = await import('@/sync/api/account/apiTokens');
        const accountContext = await captureLazyActionAccountContext(serverId);
        try {
            if (outcome === 'retired') await homes.switchAccount(serverId, 'replacement-account', { currentAccount: true });
            const options = { accountContext, signal: undefined };
            const write = updateCurrentAccountApiToken({ tokenId: token.tokenId, authorizeUnattendedTeamAccess: true }, options);
            if (outcome === 'retired') await expect(write).rejects.toThrow('account_api_tokens_unavailable');
            else if (outcome === 'unknown') await expect(write).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
            else await expect(write).resolves.toEqual({ apiToken: token });
            expect(homes.requestsFor(ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1).map(request => ({ serverId: request.serverId, token: request.token })))
                .toEqual(outcome === 'retired' ? [] : [{ serverId, token: createAccountTokenForTests('workload-account', { currentAccount: true }) }]);
        } finally { accountContext.dispose(); }
    });

    it('preserves the exact acknowledged Machine grant when recipient keys remain pending', async () => {
        const scenario = await openMoveScenario({ failure: 'grant-pending', reviewPolicy: 'waived' });
        const result = await executeReviewedMove(scenario.input, async () => true);
        expect(scenario.effects).toEqual(['machine-team']);
        expect(result).toMatchObject({ ok: true, result: { kind: 'partial', resourceEffects: {
            machineGrants: [{ machineId: 'machine-a', principal: { kind: 'team', teamId: 'team' }, level: 'admin', readiness: 'key_pending' }],
            secretCopies: [], bindings: [], renewedTokenIds: [], renewedTriggers: [],
        } } });
    });

    it('reviews demanded Move effects once and cancels without effects without a persisted Require override', async () => {
        const scenario = await openMoveScenario({ reviewPolicy: 'default' });
        let reviews = 0;
        let preview: unknown;
        const result = await executeReviewedMove(scenario.input, async request => {
            reviews++; preview = request.preview; return false;
        });
        expect(reviews).toBe(1);
        expect(preview).toMatchObject({ moveToTeam: { teamId: 'team', source: scenario.source(),
            artifactIds: scenario.originalArtifactIds, usedSecrets: [{ ref: scenario.binding.source.ref, resourceRevision: 2 }],
            ciTokens: expect.any(Array), triggers: expect.any(Array), previews: [],
        } });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(scenario.effects).toEqual([]);
    });

    it('keeps demanded Machine sharing review when the parent Move review is waived', async () => {
        const scenario = await openMoveScenario({ reviewPolicy: 'waived' });
        let reviews = 0;
        let preview: unknown;
        const result = await executeReviewedMove(scenario.input, async request => {
            reviews++; preview = request.preview; return false;
        });
        expect(reviews).toBe(1);
        expect(preview).toMatchObject({ moveToTeam: { machines: [expect.objectContaining({ machineId: 'machine-a' })] } });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(scenario.effects).toEqual([]);
    });

    it.each([['plain', false], ['plain', true], ['e2ee', true]] as const)('completes the five owner steps with one review and no surviving personal workload grant (Account mode: %s, Environment Require: %s)', async (mode, scopedRequire) => {
        const scenario = await openMoveScenario({ mode, scopedRequire });
        let reviews = 0;
        const result = await executeReviewedMove(scenario.input, async () => { reviews++; return true; });
        expect(reviews, JSON.stringify({ errorCode: result.ok ? null : result.errorCode,
            kind: result.ok && typeof result.result === 'object' && result.result !== null && 'kind' in result.result ? result.result.kind : null,
            effects: scenario.effects })).toBe(1);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'completed', source: { owner: { kind: 'team', teamId: 'team' } },
            resourceEffects: { secretCopies: [{ sourceRef: scenario.binding.source.ref, sourceRevision: 2,
                ref: expect.any(String), resourceRevision: 1 }], bindings: [{ environmentId: scenario.detail.environment.id, revision: 2 }],
            bindingArtifacts: [{ environmentId: scenario.detail.environment.id, contentArtifactId: scenario.detail.environment.contentArtifactId,
                contentHeaderVersion: scenario.detail.environment.contentHeaderVersion, contentBodyVersion: scenario.detail.environment.contentBodyVersion }],
            renewedTokenIds: expect.any(Array), renewedTriggers: [{ automationId: expect.any(String), triggerId: expect.any(String), revision: 2 }] },
        } });
        expect(scenario.effects).toEqual(['machine-team', 'secret-copy', 'bindings', 'source-owner', 'token-root', 'token-child', 'trigger',
            'machine-withdraw', 'source-audience']);
        expect(scenario.materials.get('original')).toBe(scenario.original);
        expect(scenario.source().audience).toEqual([{ principal: { kind: 'account', accountId: 'unrelated-reader' }, level: 'view' }]);
        for (const artifactId of scenario.originalArtifactIds) expect(homes.artifacts(scenario.serverId).readGrants(artifactId))
            .toContainEqual(expect.objectContaining({ principal: { kind: 'team', teamId: 'team' }, accessLevel: 'admin' }));
        expect(homes.artifacts(scenario.serverId).list().filter(artifact => artifact.kindHint === APPROVAL_ARTIFACT_KINDS_V1.builtIn)).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain('move-secret-sentinel');
        // The native review and its confirmed execution share one invocation's
        // prepared census; no separate Inbox replay re-reads the inventory.
        expect(homes.requestsFor(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)).toHaveLength(1);
        expect(homes.requestsFor(ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1)).toHaveLength(2);
        if (mode === 'e2ee') {
            expect([...scenario.preparedArtifactIds].sort()).toEqual([...scenario.originalArtifactIds, scenario.detail.environment.contentArtifactId].sort());
            expect(scenario.preparedSecretIds.size).toBe(1);
        }
    });

    it('cancels the single Move review with Environment Require before any child effect', async () => {
        const scenario = await openMoveScenario({ scopedRequire: true });
        let reviews = 0;
        const result = await executeReviewedMove(scenario.input, async () => { reviews++; return false; });
        expect(reviews, JSON.stringify({ errorCode: result.ok ? null : result.errorCode,
            kind: result.ok && typeof result.result === 'object' && result.result !== null && 'kind' in result.result ? result.result.kind : null,
            effects: scenario.effects })).toBe(1);
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(scenario.effects).toEqual([]);
    });

    it('refuses an older Environment reader without canonical retained cleanup coverage before review', async () => {
        const scenario = await openMoveScenario();
        homes.answer(scenario.serverId, `/v1/deployments/environments/${scenario.detail.environment.id}`, { body: {
            ok: true, environment: scenario.detail.environment, targetLinks: scenario.detail.targetLinks.map(item => item.targetLink),
        } });
        let reviews = 0;
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => { reviews++; return true; } });
        expect(await executor.execute('projects.sources.moveToTeam', scenario.input, { surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: false, errorCode: 'deployment_content_unavailable' });
        expect(reviews).toBe(0);
        expect(scenario.effects).toEqual([]);
    });

    it('preserves a known E2EE copy and stops before binding or owner writes when Team envelope preparation is pending', async () => {
        // The persisted waiver isolates the copy's preparation boundary; the
        // separate E2EE review/cancel control still drives native UI confirmation.
        const scenario = await openMoveScenario({ failure: 'secret-preparation-pending', reviewPolicy: 'waived' });
        const result = await executeReviewedMove(scenario.input, async () => true);
        expect(result).toMatchObject({ ok: true, result: { kind: 'partial', source: { owner: { kind: 'account', accountId: 'account-owner' } },
            resourceEffects: { secretCopies: [{ sourceRef: scenario.binding.source.ref, sourceRevision: 2,
                ref: expect.any(String), resourceRevision: 1 }], artifacts: [], bindingArtifacts: [], bindings: [],
            renewedTokenIds: [], renewedTriggers: [] },
        } });
        expect(scenario.effects).toEqual(['machine-team', 'secret-copy']);
        expect(scenario.materials.size).toBe(2);
        expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/account/saved-secrets/resources/envelope-census')).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain('move-secret-sentinel');
    });

    it('records the applied binding and exact candidate but keeps Account ownership when Team preparation cannot finish', async () => {
        const scenario = await openMoveScenario();
        const artifacts = homes.artifacts(scenario.serverId);
        const afterReview = async () => { artifacts.afterNextCreate(async () => {
            const candidate = artifacts.list().at(-1);
            if (!candidate) throw new Error('Expected P42 candidate Artifact');
            const path = `/v1/artifacts/${candidate.id}/access/grants`;
            homes.answer(scenario.serverId, `PUT ${path}`, { select: async (_raw, request) => {
                const response = await artifacts.handle(path, request.init);
                if (!response) throw new Error('Expected existing Artifact grant boundary');
                // Semantic grant ACK is retained; its required fresh content read
                // fails at the network boundary below the real preparation owner.
                homes.answer(scenario.serverId, `GET /v1/artifacts/${candidate.id}`, { status: 503, body: { error: 'unavailable' } });
                return { status: response.status, body: await response.json() };
            } });
        }); return true; };
        const result = await executeReviewedMove(scenario.input, afterReview);
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => `${request.method} ${request.path.split('?')[0]}`) })).toMatchObject({ ok: true, result: { kind: 'partial', source: { owner: { kind: 'account', accountId: 'account-owner' } },
                resourceEffects: { secretCopies: [{ ref: expect.any(String), resourceRevision: 1 }],
                    bindings: [{ environmentId: scenario.detail.environment.id, revision: 2 }],
                    bindingArtifacts: [{ environmentId: scenario.detail.environment.id, contentArtifactId: scenario.detail.environment.contentArtifactId,
                        contentHeaderVersion: scenario.detail.environment.contentHeaderVersion,
                        contentBodyVersion: scenario.detail.environment.contentBodyVersion }],
                    artifacts: expect.arrayContaining([{ artifactId: expect.any(String), preparation: { status: 'pending' } }]),
                    renewedTokenIds: [], renewedTriggers: [] },
            } });
        expect(scenario.effects).toEqual(['machine-team', 'secret-copy', 'bindings']);
        expect(homes.requestsFor('/v1/actions/deployments.bindings.set')).toHaveLength(1);
    });

    it.each(['source-conflict', 'token-unknown', 'grant-pending'] as const)('preserves old grants and the last proved Source after %s', async failure => {
        const scenario = await openMoveScenario({ failure });
        const result = await executeReviewedMove(scenario.input, async () => true);
        expect(result).toMatchObject({ ok: true, result: { kind: failure === 'token-unknown' ? 'outcome_unknown' : 'partial',
            source: { owner: failure === 'token-unknown' ? { kind: 'team', teamId: 'team' } : { kind: 'account', accountId: 'account-owner' } },
            resourceEffects: { secretCopies: failure === 'grant-pending' ? [] : [{ ref: expect.any(String), resourceRevision: 1 }],
                bindings: failure === 'grant-pending' ? [] : [{ environmentId: scenario.detail.environment.id, revision: 2 }],
                renewedTokenIds: failure === 'token-unknown' ? [expect.any(String)] : [], renewedTriggers: [] },
        } });
        expect(scenario.effects).not.toContain('machine-withdraw');
        expect(scenario.effects).not.toContain('source-audience');
        if (failure === 'grant-pending') expect(scenario.effects).toEqual(['machine-team']);
        if (failure === 'token-unknown') expect(scenario.effects.filter(effect => effect.startsWith('token-'))).toEqual(['token-root', 'token-child']);
    });

    it.each(['plain', 'e2ee'] as const)('prepares populated Move review for %s and cancels without effects through the default executor', async mode => {
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Move Home', serverUrl: 'https://source-move.test', accountId: 'account-owner',
            accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('account-owner'), secret: encodeBase64(secret, 'base64url') } } : {}),
        });
        if (mode === 'e2ee') answerMoveEncryptedCurrentness(serverId, secret);
        const source = { id: 'source-app', revision: 4, name: 'App', createdByAccountId: 'account-owner',
            owner: { kind: 'account', accountId: 'account-owner' }, audience: [] } as const;
        answerMoveDefaults(serverId, source.id, source.revision);
        homes.answer(serverId, '/v1/projects/sources/source-app', { body: { ok: true, source, canManage: true } });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId,
            controllerMachineId: 'controller', buildMachineId: 'builder', ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } }) });
        const binding = createDeploymentSecretVariableBindingV1({ name: 'DATABASE_PASSWORD', phase: 'runtime', resourceId: 'used-secret', resourceRevision: 2 });
        detail.content.bindings = [binding, { ...binding, name: 'BUILD_PASSWORD', phase: 'build' }];
        const retained = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId, id: 'retained-env',
            deletedAtMs: 2000, contentArtifactId: 'retained-content', runtimeTargetLinkId: 'retained-link',
            controllerMachineId: 'decommissioned-controller', buildMachineId: 'decommissioned-builder' }), targetLinks: [{
                targetLink: createDeploymentTargetLinkHeaderV1({ id: 'retained-link', environmentId: 'retained-env', contentArtifactId: 'retained-link-content',
                    deletedAtMs: 2000, machines: ['cleanup-machine'], members: [{ machineId: 'cleanup-machine', installationId: 'cleanup-installation', state: 'active' }] }), content: {},
            }, { targetLink: createDeploymentTargetLinkHeaderV1({ id: 'cleaned-link', environmentId: 'retained-env', contentArtifactId: 'cleaned-link-content',
                deletedAtMs: 2000, machines: ['decommissioned-cleaned'], members: [{ machineId: 'decommissioned-cleaned', installationId: 'cleaned-installation', state: 'active' }] }), content: {} }] });
        retained.content.bindings = [createDeploymentSecretVariableBindingV1({ name: 'HISTORICAL', phase: 'runtime', resourceId: 'retired-secret', resourceRevision: 1 })];
        const previewDetail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId, id: 'preview-env', purpose: 'preview',
            contentArtifactId: 'preview-content', controllerMachineId: 'controller', buildMachineId: 'builder', runtimeTargetLinkId: 'preview-link',
            previewTemplateEnvironmentId: detail.environment.id, previewRepositoryId: 'repository', previewPullRequestId: '1', previewTargetLinkId: 'target-link' }),
            targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ id: 'preview-link', environmentId: 'preview-env', contentArtifactId: 'preview-link-content' }), content: {} }] });
        const historyBase = createDeploymentReceiptDetailV1();
        const history = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'history', environmentId: retained.environment.id,
            targetLinkId: 'retained-link', contentArtifactId: 'history-content', state: 'succeeded' }), content: { ...historyBase.content,
                machines: ['decommissioned-history'], buildMachineId: 'decommissioned-builder',
                machineResults: [{ ...historyBase.content.machineResults[0]!, machineId: 'decommissioned-history' }] } });
        const all = [detail, retained, previewDetail];
        await requireMoveReview(serverId, mode === 'e2ee' ? secret : undefined);
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: all.map(item => item.environment), nextCursor: null } });
        homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}/deployments`, { body: { ok: true, items: [], nextCursor: null } });
        for (const item of [retained, previewDetail]) {
            homes.answer(serverId, `/v1/deployments/environments/${item.environment.id}`, { body: { ok: true, environment: item.environment,
                targetLinks: item.targetLinks.map(link => link.targetLink), retainedTargetLinkCleanupCompleteIds: item === retained ? ['cleaned-link'] : [] } });
            homes.answer(serverId, `/v1/deployments/environments/${item.environment.id}/deployments`, { body: { ok: true,
                items: item === retained ? [history.deployment] : [], nextCursor: null } });
        }
        homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true, environment: detail.environment,
            targetLinks: detail.targetLinks.map(link => link.targetLink), retainedTargetLinkCleanupCompleteIds: [] } });
        homes.answer(serverId, `GET /v1/projects/${source.id}/deployment-defaults`, { body: ProjectDeploymentDefaultsOutputV1Schema.parse({
            ok: true, projectSourceId: source.id, sourceRevision: source.revision, revision: 1,
            content: { contentArtifactId: 'defaults-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
        }) });
        for (const machineId of ['machine-a', 'controller', 'builder', 'edge', 'cleanup-machine']) answerMoveMachine(serverId, machineId);
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try {
            for (const item of all) {
                await writer.createArtifactDocument({ artifactId: item.environment.contentArtifactId,
                    header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: item.content.name }, body: JSON.stringify(item.content) });
                for (const link of item.targetLinks) await writer.createArtifactDocument({ artifactId: link.targetLink.contentArtifactId,
                    header: { kind: 'deployment-target-link.v1', title: 'Target' }, body: JSON.stringify(link.content) });
            }
            await writer.createArtifactDocument({ artifactId: history.deployment.contentArtifactId,
                header: { kind: 'deployment-receipt.v1', title: 'History' }, body: JSON.stringify(history.content) });
            await writer.createArtifactDocument({ artifactId: 'defaults-content', header: { kind: 'project-deployment-defaults.v1', title: 'Defaults' },
                body: JSON.stringify({ projectSourceId: source.id, deploymentDefaults: {} }) });
        } finally { writer.dispose(); }
        const token = AccountApiTokenSummaryV1Schema.parse({ tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'CI deploy',
            displayPrefix: 'hap_v1_dd03e74b', createdAt: '2026-08-22T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
            hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null, activeChildCount: 1, embedConfig: null });
        homes.answer(serverId, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, { body: { tokens: [token] } });
        let preview: unknown;
        let reviews = 0;
        const review = async (request: Readonly<{ preview?: unknown }>) => {
            reviews++;
            preview = request.preview;
            return false;
        };
        const before = homes.requests.length;
        const result = await executeReviewedMove({ serverId, sourceId: source.id,
            expectedRevision: source.revision, teamId: 'team', requestKey: 'move-a' }, review);
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(preview).toMatchObject({ moveToTeam: { teamId: 'team', source,
            environments: expect.arrayContaining([expect.objectContaining({ environmentId: detail.environment.id, revision: detail.environment.revision }),
                expect.objectContaining({ environmentId: retained.environment.id, deletedAtMs: 2000, receiptIds: ['history'] })]),
            machines: expect.arrayContaining([{ machineId: 'machine-a', roles: ['runtime'] }, { machineId: 'builder', roles: ['build'] },
                { machineId: 'controller', roles: ['controller'] }, { machineId: 'edge', roles: ['edge'] }, { machineId: 'cleanup-machine', roles: ['runtime', 'cleanup'] }]),
            usedSecrets: [{ ref: binding.source.ref, resourceRevision: 2 }],
            artifactIds: expect.arrayContaining(['retained-content', 'retained-link-content', 'cleaned-link-content', 'history-content', 'defaults-content', 'preview-content']),
            previews: [{ environmentId: 'preview-env', previewTemplateEnvironmentId: detail.environment.id, previewTargetLinkId: 'target-link' }],
            ciTokens: [{ tokenId: token.tokenId, label: token.label, hasUnattendedTeamAccess: false, activeChildCount: 1 }],
        } });
        expect(reviews).toBe(1);
        const requests = homes.requests.slice(before);
        expect(requests.filter(request => request.path.startsWith('/v1/projects/sources/') && request.method !== 'GET')).toEqual([]);
        expect(requests.filter(request => request.path.includes('/grants') && request.method !== 'GET')).toEqual([]);
        expect(requests.filter(request => request.path.endsWith('/bindings') || request.path.endsWith('/create') || request.path.endsWith('/revoke'))).toEqual([]);
        // Cancel ends this invocation at review. No second inventory or effect
        // is issued, and no retained preview becomes child execution authority.
        expect(requests.filter(request => request.path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)).toHaveLength(1);
        expect(requests.some(request => request.path.includes('/v1/machines/decommissioned-'))).toBe(false);
    });

    it('settles unavailable Move inventory before confirmation without effects', async () => {
        const serverId = await homes.addHome({ name: 'Unavailable Move inventory',
            serverUrl: 'https://source-move-unavailable.test', accountId: 'account-owner' });
        const source = { id: 'source-app', revision: 4, name: 'App', createdByAccountId: 'account-owner',
            owner: { kind: 'account', accountId: 'account-owner' }, audience: [] } as const;
        homes.answer(serverId, '/v1/projects/sources/source-app', { body: { ok: true, source, canManage: true } });
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: false, error: 'deployment_access_denied' } });
        let reviews = 0;
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => { reviews++; return false; } });
        const before = homes.requests.length;
        expect(await executor.execute('projects.sources.moveToTeam', { serverId, sourceId: source.id,
            expectedRevision: source.revision, teamId: 'team', requestKey: 'unavailable-move' },
        { surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
        expect(reviews).toBe(0);
        expect(homes.requests.slice(before).filter(request => request.method !== 'GET'
            && request.path !== ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)).toEqual([]);
    });

    it('re-admits the Source after Move review and refuses a changed owner revision before effects', async () => {
        const serverId = await homes.addHome({ name: 'Move currentness', serverUrl: 'https://source-move-current.test', accountId: 'account-owner' });
        let source = { id: 'source-app', revision: 4, name: 'App', createdByAccountId: 'account-owner',
            owner: { kind: 'account' as const, accountId: 'account-owner' }, audience: [] };
        answerMoveDefaults(serverId, source.id, source.revision);
        homes.answer(serverId, '/v1/projects/sources/source-app', { select: () => ({ body: { ok: true, source, canManage: true } }) });
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
        homes.answer(serverId, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, { body: { tokens: [] } });
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => {
            source = { ...source, revision: 5 };
            return true;
        } });
        const result = await executor.execute('projects.sources.moveToTeam', { serverId, sourceId: source.id,
            expectedRevision: 4, teamId: 'team', requestKey: 'same-move' }, { surface: 'ui', authority: 'present_user' });
        expect(result).toMatchObject({ ok: true, result: { ok: false, error: 'source_conflict', current: { revision: 5 } } });
        expect(homes.requestsFor(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)).toHaveLength(0);
        expect(homes.requestsFor('/v3/automations/query')).toHaveLength(0);
    });

    it.each([{ kind: 'team', teamId: 'team' }, { kind: 'account', accountId: 'different-owner' }] as const)(
        'does not lend creator or audience manage rights to Move a Source owned by $kind', async owner => {
            const serverId = await homes.addHome({ name: 'Move owner', serverUrl: 'https://source-move-owner.test', accountId: 'creator' });
            const source = { id: 'source', revision: 1, name: 'App', createdByAccountId: 'creator', owner, audience: [] };
            homes.answer(serverId, '/v1/projects/sources/source', { body: { ok: true, source, canManage: true } });
            const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => true });
            expect(await executor.execute('projects.sources.moveToTeam', { serverId, sourceId: source.id,
                expectedRevision: 1, teamId: 'destination', requestKey: 'move-owner' }, { surface: 'ui', authority: 'present_user' }))
                .toMatchObject({ ok: false, errorCode: 'source_access_denied' });
            expect(homes.requestsFor('/v1/deployments/environments')).toHaveLength(0);
            expect(homes.requestsFor(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)).toHaveLength(0);
        });

    it('uses the Source input Home and its actual credential across all admitted surfaces when focus is elsewhere', async () => {
        const serverId = await homes.addHome({ name: 'Named Source Home', serverUrl: 'https://named-source-actions.test', accountId: 'named-account', active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-source-actions.test', accountId: 'focused-account' });
        const path = `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}`;
        homes.answer(serverId, path, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const executor = createDefaultActionExecutor();
        for (const surface of ['ui', 'voice', 'agent', 'mcp', 'cli'] as const) {
            expect(await executor.execute('projects.sources.list', { serverId }, { surface })).toMatchObject({
                ok: true, result: { ok: true, sources: [] },
            });
        }
        expect(homes.requestsFor(path).map(request => ({ serverId: request.serverId, token: request.token })))
            .toEqual(Array.from({ length: 5 }, () => ({ serverId, token: createAccountTokenForTests('named-account') })));
        expect(homes.requests.some(request => request.path.startsWith('/v1/projects/sources') && request.serverId !== serverId)).toBe(false);
    });

    it('captures actual Home credentials and refuses another Account or Home before Source disclosure', async () => {
        const serverId = await homes.addHome({ name: 'Source Home', serverUrl: 'https://source-actions.test', accountId: 'account-a' });
        const path = `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}`;
        homes.answer(serverId, path, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('projects.sources.list', { serverId }, { serverId, surface: 'ui', expectedAccountId: 'account-a' }))
            .toMatchObject({ ok: true, result: { ok: true, sources: [] } });
        const before = homes.requestsFor(path).length;
        expect(await executor.execute('projects.sources.list', { serverId }, { serverId, surface: 'ui', expectedAccountId: 'account-b' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(await executor.execute('projects.sources.list', { serverId: 'another-home' }, { serverId, surface: 'cli' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requestsFor(path)).toHaveLength(before);
    });

    it('does not let external provenance from another Account borrow this Home bearer', async () => {
        const serverId = await homes.addHome({ name: 'Source Home', serverUrl: 'https://source-external-actions.test', accountId: 'account-a' });
        const path = `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}`;
        homes.answer(serverId, path, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const executor = createDefaultActionExecutor();
        const context = {
            serverId, surface: 'cli', externalActionCredential: { accountId: 'account-b', principalId: 'principal-b',
                credentialId: 'credential-b', grant: API_TOKEN_FULL_GRANT_V1 },
        } as const;
        const result = await executor.execute('projects.sources.list', { serverId }, context);
        expect(result.ok).toBe(false);
        expect(await executor.prepare('projects.sources.list', { serverId }, context)).toMatchObject({
            kind: 'settled', result: { ok: false, errorCode: 'action_account_scope_changed' },
        });
        expect(homes.requestsFor(path)).toEqual([]);
    });
});


it.each([false, true])('settles a Source tombstone through the UI Inbox with producer effect evidence (%s)', async producerAttempted => {
    const serverId = await homes.addHome({ name: 'Source replay', serverUrl: 'https://source-replay.test',
        accountId: 'source-owner', currentAccount: true, accountEncryptionMode: 'plain' });
    await homes.requireUiApproval(serverId, 'projects.sources.delete');
    homes.answer(serverId, 'DELETE /v1/projects/sources/deleted-source', { status: 404,
        body: { ok: false, error: 'source_unavailable', ...(producerAttempted ? { effectAttempted: true } : {}) } });
    const artifactId = await createUiApprovalRequest({ serverId, actionId: 'projects.sources.delete',
        actionInput: { serverId, sourceId: 'deleted-source', expectedRevision: 1 }, actionRequestId: 'review-source-delete' });
    const expected = { ok: true, result: { status: 'failed', execution: {
        ok: false, errorCode: 'source_unavailable', effectAttempted: producerAttempted,
    } } };
    expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject(expected);
    expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject(expected);
    expect(homes.requestsFor('/v1/projects/sources/deleted-source').filter(request => request.method === 'DELETE')).toHaveLength(1);
});


it.each(['same-home', 'other-home', 'other-account'] as const)(
    'replays a producer-created Source move from an independent device only for the same Home and Account (%s)', async decisionScope => {
        const scenario = await openMoveScenario();
        const triggerRead = await createDefaultActionExecutor().execute('workflow.trigger.list', { scope: 'account_all' }, {
            surface: 'ui', authority: 'present_user', serverId: scenario.serverId,
        });
        if (!triggerRead.ok) throw new Error(`Expected the real Workflow inventory: ${JSON.stringify(triggerRead)}`);
        const triggerInventory = WorkflowTriggerListResultV1Schema.parse(triggerRead.result);
        // The agent's inventory read crosses its installed host boundary. Reuse
        // the real Account owner's opened result beneath Home minting and crypto.
        await answerExternalActionAccountForHome(homes, scenario.serverId, {
            machineId: 'machine-a', actionId: 'workflow.trigger.list', tokenEpoch: 0,
            execute: raw => {
                expect(raw).toEqual({ scope: 'account_all' });
                return triggerInventory;
            },
        });
        await homes.requireActionApproval(scenario.serverId, 'projects.sources.moveToTeam', 'agent');
        const { getServerProfileById, listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
        const { seedPersistedHomeProfilesForTests } = await import('@/dev/testkit/fixtures/persistedHomeProfiles');
        const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const receiverProfile = getServerProfileById(scenario.serverId);
        if (!receiverProfile) throw new Error('Expected the browser Home profile');
        const receiverProfiles = listServerProfiles();
        // Device persistence is the boundary: the real producer sees its own
        // local id, and the browser later has only its independently saved id.
        const creatorServerId = 'stack_agent-qa-servers-deploy__id_default';
        const creatorInput = { ...scenario.input, serverId: creatorServerId };
        try {
            await seedPersistedHomeProfilesForTests({ activeServerId: creatorServerId,
                profiles: receiverProfiles.map(profile => profile.id === receiverProfile.id
                    ? { ...profile, id: creatorServerId, legacyServerIds: [] } : profile) });
            expect(getServerProfileById(creatorServerId)?.serverIdentityId).toBe(receiverProfile.serverIdentityId);
            const produced = await createDefaultActionExecutor().execute('projects.sources.moveToTeam', creatorInput, {
                surface: 'agent', authority: 'account_automation', serverId: creatorServerId,
                actionCaller: { kind: 'host' },
                actionRequestId: 'independent-device-source-move',
                externalActionTarget: { kind: 'machine', machineId: 'machine-a' },
            });
            expect(produced, JSON.stringify(produced)).toMatchObject({ ok: true, result: {
                kind: 'approval_request_created', artifactId: expect.any(String),
            } });
            if (!produced.ok || typeof produced.result !== 'object' || produced.result === null
                || !('artifactId' in produced.result) || typeof produced.result.artifactId !== 'string') {
                throw new Error('Expected the real producer to persist a Source move review');
            }
            const artifactId = produced.result.artifactId;
            const readApproval = () => ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(scenario.serverId).readPlainBody(artifactId) ?? 'null'));
            const pending = readApproval();
            expect(pending).toMatchObject({ status: 'open', actionArgs: creatorInput,
                executionOriginV1: { serverId: creatorServerId, serverIdentityId: receiverProfile.serverIdentityId,
                    accountId: 'account-owner' },
                preview: { hostReviewedChildren: { children: expect.arrayContaining([
                    expect.objectContaining({ action: 'projects.sources.update', role: 'source-owner',
                        input: expect.objectContaining({ serverId: creatorServerId }) }),
                    expect.objectContaining({ action: 'deployments.bindings.set',
                        scopeInput: expect.objectContaining({ serverId: creatorServerId }) }),
                ]) } },
            });
            expect(scenario.effects).toEqual([]);
            const browserProfiles = receiverProfiles.map(profile => decisionScope === 'other-home' && profile.id === receiverProfile.id
                ? { ...profile, serverIdentityId: 'srv_reinstalled_source_home', legacyServerIds: [],
                    homeConnectionDescriptor: undefined } : profile);
            await seedPersistedHomeProfilesForTests({ profiles: browserProfiles, activeServerId: receiverProfile.id });
            expect(getServerProfileById(creatorServerId)).toBeNull();
            if (decisionScope === 'other-account') await homes.switchAccount(scenario.serverId, 'another-account', { currentAccount: true });
            if (decisionScope === 'other-home') {
                await expect(decideApprovalAsInbox(receiverProfile.id, artifactId, 'approve'))
                    .rejects.toMatchObject({ name: 'AccountStorageCurrentnessUnavailableError', reason: 'unauthorized', code: 'action_home_signed_out' });
                expect(scenario.effects).toEqual([]);
                expect(scenario.source().owner).toEqual({ kind: 'account', accountId: 'account-owner' });
                return;
            }
            const decided = await decideApprovalAsInbox(receiverProfile.id, artifactId, 'approve');
            if (decisionScope === 'other-account') {
                expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false, errorCode: 'approval_not_found' });
                expect(scenario.effects).toEqual([]);
                expect(scenario.source().owner).toEqual({ kind: 'account', accountId: 'account-owner' });
                return;
            }
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
                ok: true, result: { kind: 'completed', source: { owner: { kind: 'team', teamId: 'team' } } },
            } } });
            expect(scenario.effects).toEqual(['machine-team', 'secret-copy', 'bindings', 'source-owner', 'token-root', 'token-child',
                'trigger', 'machine-withdraw', 'source-audience']);
            expect(readApproval()).toMatchObject({ actionArgs: creatorInput,
                executionOriginV1: pending.executionOriginV1, preview: pending.preview });
            await decideApprovalAsInbox(receiverProfile.id, artifactId, 'approve');
            expect(scenario.effects.filter(effect => effect === 'source-owner')).toHaveLength(1);
        } finally {
            await seedPersistedHomeProfilesForTests({ profiles: receiverProfiles, activeServerId: receiverProfile.id });
        }
    },
);


it.each(['unchanged', 'changed-child'] as const)('reviews actual CLI Source move children before browser approval (%s)', async scenarioKind => {
    const scenario = await openMoveScenario();
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(scenario.serverId);
    const terminalPayload = btoa(JSON.stringify({ sub: account.accountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const credentials = { token: `e30.${terminalPayload}.signature`, encryption: null, credentialProvenance: 'stored_session' as const };
    const serverIdentityId = account.serverIdentityId!;
    const serverUrl = account.endpointUrl;
    account.dispose();
    const adapter = axios.defaults.adapter;
    const nativeFetch = globalThis.fetch;
    // HTTP is the cross-package boundary; both real Account/Artifact owners share the same Home rows.
    globalThis.fetch = (input, init) => homes.request(input, init);
    axios.defaults.adapter = async config => {
        const url = new URL(config.url!, config.baseURL);
        for (const [key, value] of Object.entries(config.params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
        const response = await homes.request(url.href, { method: config.method?.toUpperCase(),
            headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)])),
            ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }),
            ...(config.signal ? { signal: config.signal as AbortSignal } : {}) });
        return { status: response.status, statusText: response.statusText, headers: {}, data: await response.json(), config };
    };
    onTestFinished(() => { axios.defaults.adapter = adapter; globalThis.fetch = nativeFetch; });
    // Load the real CLI host without rooting the CLI TypeScript program in the UI compilation.
    const cliHostPath = '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
    const { createCliActionExecutorFromCredentials } = await vi.importActual<{
        createCliActionExecutorFromCredentials(options: Readonly<{
            credentials: typeof credentials; readCredentials(): Promise<typeof credentials>;
            serverId: string; serverIdentityId: string; serverApiUrl: string;
        }>): Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
    }>(cliHostPath);
    await homes.requireActionApproval(scenario.serverId, 'projects.sources.moveToTeam', 'cli');
    const creator = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId: scenario.serverId, serverIdentityId, serverApiUrl: serverUrl });
    const produced = await creator.execute('projects.sources.moveToTeam', scenario.input, {
        surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: scenario.serverId, serverIdentityId, runtimeAccountId: 'account-owner',
        actionRequestId: 'cli-source-move-review',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'projects.sources.moveToTeam': { approvalRequiredSurfaces: ['cli'] },
        } }),
    });
    expect(produced, JSON.stringify(produced)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    if (!produced.ok || !produced.result || typeof produced.result !== 'object' || !('artifactId' in produced.result)
        || typeof produced.result.artifactId !== 'string') throw new Error('Expected CLI approval');
    const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const pending = ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(scenario.serverId)
        .readPlainBody(produced.result.artifactId) ?? 'null'));
    expect(pending).toMatchObject({ status: 'open', preview: { hostReviewedChildren: { children: expect.arrayContaining([
        expect.objectContaining({ action: 'machines.access.grant.set', role: expect.any(String) }),
        expect.objectContaining({ action: 'artifact.access.grants.set', role: expect.any(String) }),
    ]) } } });
    expect(scenario.effects).toEqual([]);
    if (scenarioKind === 'changed-child') {
        scenario.detail.environment.buildMachineId = 'machine-new';
        answerMoveMachine(scenario.serverId, 'machine-new');
    }
    const decided = await decideApprovalAsInbox(scenario.serverId, produced.result.artifactId, 'approve');
    if (scenarioKind === 'changed-child') {
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'failed',
            execution: { ok: false, errorCode: 'approval_stale' } } });
        expect(scenario.effects).toEqual([]);
    } else {
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true,
            result: { kind: 'completed', source: { owner: { kind: 'team', teamId: 'team' } } } } } });
        expect(scenario.effects).toContain('machine-team');
        expect(scenario.source().owner).toEqual({ kind: 'team', teamId: 'team' });
    }
});
