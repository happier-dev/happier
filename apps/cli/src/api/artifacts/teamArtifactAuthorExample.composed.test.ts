import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createArtifactAccessActionsV1 } from '@happier-dev/protocol/actions/executor/artifactAccessActions';
import { createActionExecutor, encodeBase64, signAccountContentKeyBindingV1, computeContentPublicKeyFingerprint } from '@happier-dev/protocol';
import { createTeamDocument, updateTeamDocument } from '../../../../../packages/plugin-sdk/examples/public-authoring/teamArtifacts';
import { createAccountArtifactStore } from './accountArtifactStore';
import { createCliArtifactActions } from '@/session/actions/artifactActions';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

// Home HTTP and approval persistence are substituted boundaries; SDK invocation,
// Action policy, codecs, grants and recipient opening use their real owners.
const { get, post, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: Object.assign(actual.default.create(), actual.default, { get, post, put }) };
});
beforeEach(() => vi.resetAllMocks());

async function fixture(mode: 'plain' | 'e2ee', deferredAction?: string) {
    const ownerSecret = randomBytes(32);
    const recipientSecret = randomBytes(32);
    const recipientPublic = x25519.getPublicKey(recipientSecret);
    const signingSeed = randomBytes(32);
    const signingPublic = ed25519.getPublicKey(signingSeed);
    const fingerprint = computeContentPublicKeyFingerprint(recipientPublic);
    const store = (accountId: string, secret: Uint8Array) => createAccountArtifactStore({
        credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
            encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey: secret, publicKey: x25519.getPublicKey(secret) } },
        getAccountEncryptionMode: async () => mode,
    });
    const owner = store('owner', ownerSecret);
    const recipient = store('recipient', recipientSecret);
    let row: Record<string, unknown> | null = null;
    let shared = false;
    let recipientEnvelope: string | null = null;
    let hideRecipientKey = false;
    let writes = 0;
    const isRecipient = (config: { headers: Record<string, string> }) =>
        config.headers.Authorization?.includes(Buffer.from(JSON.stringify({ sub: 'recipient' })).toString('base64url'));
    const grant = { principal: { kind: 'team', teamId: 'team' }, accessLevel: 'edit', createdByAccountId: 'owner',
        createdAt: 1, display: { name: 'Team' } };
    const census = (recipientCall: boolean) => ({ artifactId: row!.id, ownerAccountId: 'owner',
        access: recipientCall ? 'edit' : 'owner', encryptionMode: mode, dataEncryptionKey: row!.dataEncryptionKey,
        callerDataEncryptionKey: recipientCall ? hideRecipientKey ? null : recipientEnvelope : row!.dataEncryptionKey,
        recipients: shared && mode === 'e2ee' ? [{ recipientAccountId: 'recipient', contentPublicKeyFingerprint: fingerprint,
            encryptedDataKey: recipientEnvelope, recipientContentPublicKeyFingerprint: recipientEnvelope ? fingerprint : null,
            contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'),
                contentPublicKey: encodeBase64(recipientPublic), contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: new Uint8Array([...signingSeed, ...signingPublic]), contentPublicKey: recipientPublic })) } }] : [] });
    get.mockImplementation(async (url: string, config) => {
        const recipientCall = isRecipient(config);
        if (!row || (recipientCall && !shared)) return { status: 404, data: {} };
        if (url.endsWith('/recipients')) return { status: 200, data: census(recipientCall) };
        // artifactAccessService's exact-read owner refuses a missing recipient
        // envelope; artifactsRoutes returns this 409 instead of an invalid row.
        if (recipientCall && mode === 'e2ee' && hideRecipientKey)
            return { status: 409, data: { error: 'artifact_content_unavailable' } };
        return { status: 200, data: { ...row, access: recipientCall ? 'edit' : 'owner',
            dataEncryptionKey: recipientCall && mode === 'e2ee' ? recipientEnvelope : row.dataEncryptionKey } };
    });
    put.mockImplementation(async (_url, input) => {
        expect(input).toMatchObject({ principal: grant.principal, accessLevel: 'edit' });
        shared = true;
        return { status: 200, data: { artifactId: row!.id, ownerAccountId: 'owner', access: 'owner', grants: [grant], changed: true } };
    });
    post.mockImplementation(async (url: string, input: unknown) => {
        if (url.endsWith('/key-envelopes')) {
            const commit = z.object({ recipientKeyEnvelopes: z.array(z.object({ encryptedDataKey: z.string() })) }).parse(input);
            recipientEnvelope = commit.recipientKeyEnvelopes[0]!.encryptedDataKey;
            return { status: 200, data: { appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] } };
        }
        const wire = z.record(z.string(), z.unknown()).parse(input);
        writes++;
        if (!row) {
            row = { ...wire, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            return { status: 200, data: { id: row.id, headerVersion: 1, bodyVersion: 1 } };
        }
        expect(wire).toMatchObject({ expectedHeaderVersion: row.headerVersion, expectedBodyVersion: row.bodyVersion });
        row = { ...row, ...wire, headerVersion: Number(row.headerVersion) + 1, bodyVersion: Number(row.bodyVersion) + 1 };
        return { status: 200, data: { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
    });
    const actions = (storage: typeof owner) => {
        const documents = createCliArtifactActions({ store: storage,
            beforeDelete: async () => { throw new Error('not used'); }, resolvePublishCaller: async () => null });
        const grants = createArtifactAccessActionsV1({ read: storage.read, transport: storage.accessGrants });
        const pluginId = 'examples.team-documents';
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: deferredAction
            ? { [deferredAction]: { approvalRequiredSurfaces: ['plugin'] } } : {},
            approvalWaivedSurfaces: Object.fromEntries(['artifact.create', 'artifact.access.grants.set', 'artifact.get', 'artifact.update']
                .filter(actionId => actionId !== deferredAction).map(actionId => [actionId, ['plugin']])) });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            artifactAction: documents, artifactAccessAction: args => grants(args),
            // Home approval-Artifact persistence is the substituted boundary.
            approvalsCreate: async () => ({ artifactId: 'approval' }),
        });
        return createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'document', qualifiedId: `${pluginId}/actions/document` },
                occurrenceId: 'team-document-occurrence',
                correlationId: 'team-document-request',
                sourceCustody: { kind: 'development', registeredRootId: 'team-document-root' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
                surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                approvalContext: { serverId: 'home', serverIdentityId: 'srv_home', approvalProfileId: 'builtin:full-trust' },
            },
            // The CLI host supplies Account settings after the SDK boundary
            // (createCliActionExecutor.resolveContext); policy remains real.
            actionExecutor: { execute: (id, input, context) => executor.execute(id, input,
                { ...context, actionsSettings: settings }) },
            invokeContributedAction: async () => { throw new Error('unused contributed Action transport'); },
        });
    };
    return { owner: actions(owner), recipient: actions(recipient), read: recipient.read,
        writes: () => writes, hideRecipientKey: () => { hideRecipientKey = true; } };
}

it.each(['plain', 'e2ee'] as const)('shares an author document with a Team and edits with the %s recipient codec', async mode => {
    const f = await fixture(mode);
    const created = await createTeamDocument(f.owner, 'team', { header: { title: 'Team notes' }, body: 'Draft' });
    expect(created).toHaveProperty('sharing.changed', true);
    if (!('artifactId' in created)) throw new Error('unexpected approval');
    expect(await f.read(created.artifactId)).toMatchObject({ body: 'Draft', access: 'edit' });
    await expect(updateTeamDocument(f.recipient, created.artifactId, 'Reviewed')).resolves.toMatchObject({
        revision: { headerVersion: 2, bodyVersion: 2 } });
    expect(await f.read(created.artifactId)).toMatchObject({ body: 'Reviewed', header: { title: 'Team notes' } });
    if (mode === 'e2ee') {
        f.hideRecipientKey();
        const before = f.writes();
        await expect(updateTeamDocument(f.recipient, created.artifactId, 'Must not write')).rejects.toMatchObject({
            code: 'artifact_encryption_material_unavailable' });
        expect(f.writes()).toBe(before);
    }
});

it.each(['artifact.create', 'artifact.access.grants.set', 'artifact.get', 'artifact.update'] as const)(
    'preserves %s approval deferral without advancing dependent work', async deferredAction => {
        const f = await fixture('plain', deferredAction);
        const approval: ActionApprovalRequestCreatedResult = { kind: 'approval_request_created',
            artifactId: 'approval', actionId: deferredAction };
        const created = await createTeamDocument(f.owner, 'team', { header: { title: 'Notes' }, body: 'Draft' });
        if (deferredAction === 'artifact.create') {
            expect(created).toMatchObject(approval);
            expect(f.writes()).toBe(0);
            expect(put).not.toHaveBeenCalled();
        } else if (deferredAction === 'artifact.access.grants.set') {
            expect(created).toMatchObject({ artifactId: expect.any(String), sharing: approval });
            expect(f.writes()).toBe(1);
            expect(put).not.toHaveBeenCalled();
        } else {
            if (!('sharing' in created)) throw new Error('unexpected create approval');
            await expect(updateTeamDocument(f.recipient, created.artifactId, 'Edit')).resolves.toMatchObject(approval);
            expect(f.writes()).toBe(1);
        }
    },
);

it('leaves a missing recipient document unavailable without creating a replacement', async () => {
    const f = await fixture('plain');
    await expect(updateTeamDocument(f.recipient, 'missing', 'Edit')).resolves.toEqual({ artifact: null });
    expect(f.writes()).toBe(0);
});
