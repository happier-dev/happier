import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    openEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
    validateWorkflowDefinition,
    verifyAccountContentKeyBindingV1,
    withArtifactExcerptV1,
    openPublicShareDataKeyV1,
    type ArtifactAccessGrantRowV1,
    type ArtifactRecipientKeyEnvelopeCommitInputV1,
} from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createDefaultActionExecutor } from './defaultActionExecutor';

// Only HTTP, device credentials and native UI modules are substituted. Account,
// Artifact, Action, kind-policy and cryptographic owners execute their real logic.
installApprovalCommonModuleMocks({ storage: (importOriginal) => importOriginal() });
const initialStorageState = getStorage().getState();
afterEach(() => {
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialStorageState, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function fixture(mode: 'plain' | 'e2ee', document?: Readonly<{ header: Record<string, unknown>; body: string }>) {
    const home = await upsertAndActivateServer({ serverUrl: `https://document-sharing-${mode}.test`, scope: 'tab' });
    await upsertAndActivateServer({ serverUrl: `https://focused-sharing-${mode}.test`, scope: 'tab' });
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain'
        ? { token } : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
    getStorage().setState({ settingsScope: { serverId: home.id, accountId: 'owner' } });
    let stored: Artifact | undefined;
    let access: 'owner' | 'edit' = 'owner';
    let grantStatus = 200;
    let censusCallerEnvelope: string | undefined;
    let makeMutationUnreadable = false;
    let restoreQuota: Readonly<{ error: 'quota_exceeded'; budget: 'document'; limitBytes: number; usedBytes: number }> | null = null;
    const revisions: { bodyVersion: number; body: string; createdAt: number; sizeBytes: number }[] = [];
    let grants: ArtifactAccessGrantRowV1[] = [];
    const requests: string[] = [];
    let publicLinkBody: Record<string, unknown> | undefined;
    const publicShare = { id: 'share-1', subject: { kind: 'artifact', id: 'document' }, expiresAt: null, maxUses: null,
        useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    const envelopes: ArtifactRecipientKeyEnvelopeCommitInputV1[] = [];
    const recipientSecret = new Uint8Array(32).fill(17);
    const contentPublicKey = x25519.getPublicKey(recipientSecret);
    const signingSecret = new Uint8Array(32).fill(19);
    const signingPublic = ed25519.getPublicKey(signingSecret);
    const signature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey,
    });
    const fingerprint = verifyAccountContentKeyBindingV1({ accountSigningPublicKey: signingPublic, contentPublicKey, signature })!.contentPublicKeyFingerprint;
    const projection = () => ({ artifactId: 'document', ownerAccountId: 'owner', access, grants });
    setRuntimeFetch(async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        expect(target.origin).toBe(home.serverUrl);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        requests.push(`${init?.method ?? 'GET'} ${target.pathname}`);
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode, updatedAt: 0 });
        if (target.pathname === '/v1/public-shares') {
            if (init?.method === 'POST') {
                publicLinkBody = JSON.parse(String(init.body));
                return Response.json({ publicShare, isolatedOrigin: 'https://public.example.test' });
            }
            expect(target.searchParams.get('subjectKind')).toBe('artifact');
            expect(target.searchParams.get('subjectId')).toBe('document');
            return Response.json({ publicShares: [publicShare] });
        }
        if (target.pathname === '/v1/public-shares/share-1' && init?.method === 'DELETE') return Response.json({ success: true });
        if (target.pathname === '/v1/artifacts/storage/usage') return Response.json({ usedBytes: 321, limitBytes: null,
            documentLimitBytes: null, revisionRetentionCount: 10 });
        if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
            const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
            stored = { ...input, ownerAccountId: 'owner', access, encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            return Response.json(stored);
        }
        if (stored && target.pathname === '/v1/artifacts/document') {
            if (init?.method === 'POST') {
                const input = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
                if (input.expectedHeaderVersion !== stored.headerVersion || input.expectedBodyVersion !== stored.bodyVersion)
                    return Response.json({ success: false, error: 'version-mismatch' });
                if (stored.body) revisions.push({ bodyVersion: stored.bodyVersion!, body: stored.body,
                    createdAt: stored.updatedAt, sizeBytes: decodeBase64(stored.body).byteLength });
                stored = { ...stored, header: input.header!, body: input.body!,
                    provenance: input.provenance ?? stored.provenance,
                    provenanceDataEncryptionKey: input.provenanceDataEncryptionKey ?? stored.provenanceDataEncryptionKey,
                    headerVersion: stored.headerVersion + 1, bodyVersion: stored.bodyVersion! + 1, seq: stored.seq + 1 };
                return Response.json({ success: true, headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion });
            }
            return Response.json({ ...stored, ownerAccountId: 'owner', access, encryptionMode: mode });
        }
        if (stored && target.pathname === '/v1/artifacts/document/revisions') return Response.json({ revisions, retentionCount: 10 });
        if (stored && target.pathname === '/v1/artifacts/document/revisions/1/restore') {
            if (restoreQuota) return Response.json(restoreQuota, { status: 413 });
            const input = JSON.parse(String(init?.body)) as { header: string; body: string; provenance?: string;
                provenanceDataEncryptionKey?: string; expectedHeaderVersion: number; expectedBodyVersion: number };
            if (input.expectedHeaderVersion !== stored.headerVersion || input.expectedBodyVersion !== stored.bodyVersion)
                return Response.json({ success: false, error: 'version-mismatch', currentHeaderVersion: stored.headerVersion,
                    currentBodyVersion: stored.bodyVersion, currentHeader: stored.header, currentBody: stored.body });
            revisions.push({ bodyVersion: stored.bodyVersion!, body: stored.body!, createdAt: stored.updatedAt,
                sizeBytes: decodeBase64(stored.body!).byteLength });
            stored = { ...stored, header: input.header, body: input.body,
                provenance: input.provenance ?? null,
                provenanceDataEncryptionKey: input.provenanceDataEncryptionKey ?? stored.provenanceDataEncryptionKey,
                headerVersion: stored.headerVersion + 1,
                bodyVersion: stored.bodyVersion! + 1, seq: stored.seq + 1 };
            return Response.json({ success: true, headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion });
        }
        if (target.pathname === '/v1/artifacts/document/access/grants') {
            if (grantStatus !== 200) return Response.json({ error: 'not_found' }, { status: grantStatus });
            if (init?.method === 'PUT') {
                const input = JSON.parse(String(init.body)) as { principal: ArtifactAccessGrantRowV1['principal']; accessLevel: ArtifactAccessGrantRowV1['accessLevel'] };
                grants = [{ principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'owner', createdAt: 1, display: { name: 'Recipient' } }];
                if (makeMutationUnreadable && stored) stored = { ...stored, dataEncryptionKey: encodeBase64(new Uint8Array(105).fill(1)) };
            }
            if (init?.method === 'DELETE') grants = [];
            return Response.json({ ...projection(), ...(init?.method === 'PUT' || init?.method === 'DELETE' ? { changed: true } : {}) });
        }
        if (stored && target.pathname === '/v1/artifacts/document/access/recipients') return Response.json({
            artifactId: 'document', ownerAccountId: 'owner', access, encryptionMode: mode,
            dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: censusCallerEnvelope ?? stored.dataEncryptionKey,
            provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey ?? null,
            callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey ?? null,
            recipients: grants.length ? [{ recipientAccountId: 'recipient',
                contentKey: { status: 'available', accountSigningPublicKey: encodeHex(signingPublic),
                    contentPublicKey: encodeBase64(contentPublicKey), contentPublicKeySignature: encodeBase64(signature) },
                contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, encryptedProvenanceDataKey: null,
                recipientContentPublicKeyFingerprint: null,
            }] : [],
        });
        if (target.pathname === '/v1/artifacts/document/access/key-envelopes') {
            const input = JSON.parse(String(init?.body)) as ArtifactRecipientKeyEnvelopeCommitInputV1;
            envelopes.push(input);
            return Response.json({ appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] });
        }
        throw new Error(`Unexpected sharing HTTP request: ${target.pathname}`);
    });
    const account = await captureLazyActionAccountContext(home.id);
    const header = document?.header ?? { title: 'Document' };
    const body = document?.body ?? 'definition';
    // Seed the HTTP store with canonical bytes; creation compatibility is tested
    // by the existing Artifact tests, independently of the sharing front door.
    if (mode === 'plain') stored = { id: 'document', ownerAccountId: 'owner', access, encryptionMode: mode,
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    else await account.workflowArtifacts.create({ artifactId: 'document', header, body });
    const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    return { account, context, executor: createDefaultActionExecutor(), requests, envelopes, recipientSecret, fingerprint,
        publicLinkBody: () => publicLinkBody,
        stored: () => stored!, setAccess: (value: typeof access) => { access = value; },
        setGrantStatus: (value: number) => { grantStatus = value; }, setCensusCallerEnvelope: (value: string) => { censusCallerEnvelope = value; },
        setRestoreQuota: () => { restoreQuota = { error: 'quota_exceeded', budget: 'document', limitBytes: 10, usedBytes: 20 }; },
        makeMutationUnreadable: () => { makeMutationUnreadable = true; } };
}

describe('UI Artifact sharing Action front door', () => {
    it.each(['widget-area-layout.v1', 'home-hub-layout.v1'])('refuses public publication of %s before transport', async kind => {
        const f = await fixture('plain', { header: { kind }, body: '{}' });
        try {
            expect(await f.executor.execute('artifact.public_link.create', { artifactId: 'document' }, {
                ...f.context, presentUserConfirmation: { actionId: 'artifact.public_link.create' },
            })).toMatchObject({ ok: false, errorCode: 'artifact_kind_not_shareable' });
            expect(f.requests.some(request => request.startsWith('POST /v1/public-shares'))).toBe(false);
        } finally { f.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('returns, lists and revokes %s public links without sending secrets to the captured Home', async mode => {
        const f = await fixture(mode, { header: { title: 'Public note' }, body: 'note' });
        try {
            const created = await f.executor.execute('artifact.public_link.create', { artifactId: 'document' }, {
                ...f.context, presentUserConfirmation: { actionId: 'artifact.public_link.create' },
            });
            expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { publicShare: { id: 'share-1' } } });
            const url = (created as { result: { url: string } }).result.url;
            const parsed = new URL(url);
            const local = { url, lookupId: parsed.pathname.split('/').at(-1)!, secret: new URLSearchParams(parsed.hash.slice(1)).get('k')! };
            expect(local.url).toBe(`https://public.example.test/s/${local.lookupId}#k=${local.secret}`);
            expect(local.secret).toBeTruthy();
            expect(JSON.stringify(f.publicLinkBody())).not.toContain(local.secret);
            if (mode === 'e2ee') expect(openPublicShareDataKeyV1({ encryptedDataKey: String(f.publicLinkBody()!.encryptedDataKey), secret: local.secret })).toHaveLength(32);
            else expect(f.publicLinkBody()).not.toHaveProperty('encryptedDataKey');
            expect(await f.executor.execute('artifact.public_link.list', { artifactId: 'document' }, {
                ...f.context, presentUserConfirmation: { actionId: 'artifact.public_link.list' },
            })).toMatchObject({ ok: true, result: { publicShares: [{ id: 'share-1' }] } });
            expect(await f.executor.execute('artifact.public_link.revoke', { artifactId: 'document', shareId: 'share-1' }, {
                ...f.context, presentUserConfirmation: { actionId: 'artifact.public_link.revoke' },
            })).toMatchObject({ ok: true, result: { revoked: true } });
        } finally { f.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('lists retained bodies, restores a kind-coherent %s workflow and reads storage usage on the captured Home', async (mode) => {
        const definition = validateWorkflowDefinition({ version: 1,
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
            blocks: ['Retained work'],
        }).normalizedDefinition!;
        const originalBody = JSON.stringify({ kind: 'workflow-definition.v1', definition });
        const header = { kind: 'workflow-definition.v1', definitionId: 'document', revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Workflow' } };
        const f = await fixture(mode, { header, body: originalBody });
        try {
            const nextHeader = { ...header, metadata: { title: 'Current title' }, revision: { headerVersion: 2, bodyVersion: 2 } };
            const nextBody = JSON.stringify({ kind: 'workflow-definition.v1', definition: { ...definition,
                blocks: definition.blocks.map(block => ({ ...block, name: 'Current body' })) } });
            await expect(f.account.workflowArtifacts.update({ artifactId: 'document', expectedRevision: header.revision,
                header: nextHeader, body: nextBody })).resolves.toEqual({ ok: true, revision: nextHeader.revision });
            const listed = await f.executor.execute('artifact.revisions.list', { artifactId: 'document' }, f.context);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { artifactId: 'document', retentionCount: 10,
                revisions: [{ bodyVersion: 1, body: originalBody, createdAt: 1 }] } });
            await expect(f.executor.execute('artifact.storage.usage', {}, f.context)).resolves.toEqual({ ok: true,
                result: { usedBytes: 321, limitBytes: null, documentLimitBytes: null, revisionRetentionCount: 10 } });
            await expect(f.executor.execute('artifact.revisions.restore', { artifactId: 'document', bodyVersion: 1,
                expectedRevision: nextHeader.revision }, f.context)).resolves.toEqual({ ok: true,
                result: { artifactId: 'document', revision: { headerVersion: 3, bodyVersion: 3 } } });
            const restored = await f.account.workflowArtifacts.read('document');
            expect(restored).toMatchObject({ body: originalBody, header: withArtifactExcerptV1({ ...nextHeader,
                revision: { headerVersion: 3, bodyVersion: 3 } }, originalBody), revision: { headerVersion: 3, bodyVersion: 3 } });
            await expect(f.executor.execute('artifact.access.grants.set', { artifactId: 'document',
                principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view' }, f.context))
                .resolves.toMatchObject({ ok: true, result: { changed: true } });
            expect(getStorage().getState().artifacts['document']).toMatchObject({ body: originalBody, headerVersion: 3, bodyVersion: 3 });
            const stale = await f.executor.execute('artifact.revisions.restore', { artifactId: 'document', bodyVersion: 1,
                expectedRevision: nextHeader.revision }, f.context);
            expect(stale).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            f.setRestoreQuota();
            await expect(f.executor.execute('artifact.revisions.restore', { artifactId: 'document', bodyVersion: 1,
                expectedRevision: { headerVersion: 3, bodyVersion: 3 } }, f.context)).resolves.toMatchObject({ ok: false,
                errorCode: 'quota_exceeded', details: { budget: 'document', limitBytes: 10, usedBytes: 20 } });
            expect(f.stored()).toMatchObject({ headerVersion: 3, bodyVersion: 3 });
        } finally { f.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('lists, grants and removes %s documents on the captured Home', async (mode) => {
        const f = await fixture(mode);
        try {
            const principal = { kind: 'account', accountId: 'recipient' } as const;
            const listed = await f.executor.execute('artifact.access.grants.list', { artifactId: 'document' }, f.context);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { grants: [] } });
            await expect(f.executor.execute('artifact.access.grants.set', { artifactId: 'document', principal, accessLevel: 'edit' }, f.context))
                .resolves.toMatchObject({ ok: true, result: { changed: true, grants: [{ principal, accessLevel: 'edit' }] } });
            await expect(f.executor.execute('artifact.access.grants.list', { artifactId: 'document' }, f.context))
                .resolves.toMatchObject({ ok: true, result: { grants: [{ principal, accessLevel: 'edit' }] } });
            if (mode === 'plain') {
                expect(f.stored().dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
                expect(f.envelopes).toEqual([]);
                expect(f.requests.some((path) => path.endsWith('/recipients'))).toBe(false);
            } else {
                const encryption = (await f.account.resolveAccountEncryption()).encryption!;
                const [documentKey] = await encryption.decryptEncryptionKeys([f.stored().dataEncryptionKey]);
                expect(f.envelopes.length).toBeGreaterThan(0);
                for (const input of f.envelopes) {
                    expect(input.expectedDataEncryptionKey).toBe(f.stored().dataEncryptionKey);
                    const recipient = input.recipientKeyEnvelopes[0]!;
                    expect(recipient.recipientContentPublicKeyFingerprint).toBe(f.fingerprint);
                    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(recipient.encryptedDataKey), recipientSecretKeyOrSeed: f.recipientSecret })).toEqual(documentKey);
                }
            }
            await expect(f.executor.execute('artifact.access.grants.remove', { artifactId: 'document', principal }, f.context))
                .resolves.toMatchObject({ ok: true, result: { changed: true, grants: [] } });
        } finally { f.account.dispose(); }
    });

    it('allows grantee roster reads but refuses non-owner mutations before grant transport', async () => {
        const f = await fixture('plain');
        try {
            f.setAccess('edit');
            await expect(f.executor.execute('artifact.access.grants.list', { artifactId: 'document' }, f.context))
                .resolves.toMatchObject({ ok: true, result: { access: 'edit' } });
            const principal = { kind: 'account', accountId: 'recipient' } as const;
            for (const action of ['artifact.access.grants.set', 'artifact.access.grants.remove'] as const) {
                await expect(f.executor.execute(action, { artifactId: 'document', principal, ...(action.endsWith('.set') ? { accessLevel: 'view' } : {}) }, f.context))
                    .resolves.toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
            }
            expect(f.requests.filter((path) => /^(PUT|DELETE) .*\/access\/grants$/.test(path))).toEqual([]);
        } finally { f.account.dispose(); }
    });

    it.each([
        { header: { title: 'Notes' }, body: 'Ordinary private notes' },
        { header: { kind: 'role.v1', name: 'Builder' }, body: JSON.stringify({ name: 'Builder', instructions: 'Build', runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true }) },
        { header: { kind: 'launch-profile.v1', profileId: 'deploy', name: 'Deploy' }, body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'deploy', name: 'Deploy', createdAt: 1, updatedAt: 1 }, secretBindings: {} }) },
    ])('shares a valid $header.kind document through its canonical adapter', async (document) => {
        const f = await fixture('plain', document);
        try {
            await expect(f.executor.execute('artifact.access.grants.set', {
                artifactId: 'document', principal: { kind: 'team', teamId: 'team' }, accessLevel: 'view',
            }, f.context)).resolves.toMatchObject({ ok: true, result: { changed: true } });
        } finally { f.account.dispose(); }
    });

    it.each([
        { header: { kind: 'workflow-definition.v1', definitionId: 'document',
            revision: { headerVersion: 9, bodyVersion: 9 }, metadata: { title: 'Stale workflow' } }, body: 'notes' },
        { header: { kind: 'launch-profile.v1', profileId: 'deploy', name: 'Deploy' }, body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
            v: 2, id: 'deploy', name: 'Deploy', createdAt: 1, updatedAt: 1,
            extraEnvironmentVariables: [{ name: 'TOKEN', value: 'secret', isSecret: true }],
        }, secretBindings: {} }) },
    ])('refuses an unshareable $header.kind document before granting access', async (document) => {
        const f = await fixture('plain', document);
        try {
            await expect(f.executor.execute('artifact.access.grants.set', {
                artifactId: 'document', principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view',
            }, f.context)).resolves.toMatchObject({ ok: false, error: 'artifact_kind_not_shareable' });
            expect(f.requests.filter((path) => path === 'PUT /v1/artifacts/document/access/grants')).toEqual([]);
        } finally { f.account.dispose(); }
    });

    it('degrades only sharing when the captured Home has no grant route', async () => {
        const f = await fixture('plain');
        try {
            f.setGrantStatus(404);
            await expect(f.executor.execute('artifact.access.grants.list', { artifactId: 'document' }, f.context))
                .resolves.toMatchObject({ ok: false, error: 'artifact_access_unavailable' });
            expect(await f.account.workflowArtifacts.read('document')).toMatchObject({ artifactId: 'document' });
        } finally { f.account.dispose(); }
    });

    it('refuses preparing an encrypted key after the census caller envelope changed', async () => {
        const f = await fixture('e2ee');
        try {
            f.setCensusCallerEnvelope(encodeBase64(new Uint8Array(105).fill(1)));
            await expect(f.executor.execute('artifact.access.grants.set', {
                artifactId: 'document', principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view',
            }, f.context)).resolves.toMatchObject({ ok: false, error: 'artifact_data_key_changed' });
            expect(f.envelopes).toEqual([]);
            expect(f.requests.filter((path) => path === 'PUT /v1/artifacts/document/access/grants')).toEqual([]);
        } finally { f.account.dispose(); }
    });

    it('does not report successful sharing when the resulting encrypted Artifact cannot open', async () => {
        const f = await fixture('e2ee');
        try {
            f.makeMutationUnreadable();
            await expect(f.executor.execute('artifact.access.grants.set', {
                artifactId: 'document', principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view',
            }, f.context)).resolves.toMatchObject({ ok: false, errorCode: 'action_failed' });
            expect(f.envelopes).toEqual([]);
        } finally { f.account.dispose(); }
    });
});
