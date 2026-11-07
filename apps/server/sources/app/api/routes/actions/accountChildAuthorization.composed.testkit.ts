import { expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { prepareDocDiscussionMutationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { buildDiscussionMutationRequestBodyV1, DISCUSSION_HTTP_PATHS_V1 } from '@happier-dev/protocol/discussions/api';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerTeamCredentialResourceRoutes } from '@/app/teams/credentials/registerTeamCredentialResourceRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { homeDomainActionPathForMethod } from './homeDomainActionRoute';
import { registerAccountPublicProfileRoutes } from '../account/registerAccountPublicProfileRoutes';
import { createReviewedChildAuthorizationFixture } from './reviewedChildAuthorization.composed.testkit';

type Fixture = Awaited<ReturnType<typeof createReviewedChildAuthorizationFixture>>;
const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Reviewed passage' }] };

async function artifact(f: Fixture) {
    const created = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
        header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Reviewed Doc' })),
        body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Reviewed passage' })),
        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!created.ok) throw new Error(created.error);
    return created.artifact;
}

async function discussion(f: Fixture) {
    const body = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
        titleContent: { t: 'plain', v: { v: 1, title: 'Reviewed comments' } },
        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: content },
            authoredContent: content, mentionedAccountIds: [] } });
    const response = await f.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.collection,
        headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: body });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().discussion.id as string;
}

/** Post-refactor characterization using the private host or native sibling issuer and real CLI signatures. */
export function registerAccountChildAuthorizationComposedTests(): void {
    it('exports Team credential usage through its native query sibling and refuses a freshly signed Account read', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerTeamCredentialResourceRoutes(app);
        await app.ready();
        try {
            const team = await db.team.create({ data: { name: 'Reviewed usage export' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: f.account.id, role: 'admin' } });
            const resource = await db.teamCredentialResource.create({ data: { teamId: team.id,
                custodianAccountId: f.account.id, displayName: 'Reviewed model', disclosureCeiling: 'brokered_only',
                sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered' } });
            const input = { query: { resourceId: resource.id, startMs: 0, endMs: Date.now(),
                granularity: 'day', costMode: 'auto' }, resourceName: resource.displayName };
            const root = await f.root('teams.credentials.usage.export', input);
            const executor = createActionExecutor({ homeDomainAction: async ({ actionId, input: body, context }) => {
                const path = homeDomainActionPathForMethod(actionId, 'POST');
                const response = await app.inject({ method: 'POST', url: path, payload: body,
                    headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: actionId, method: 'POST', path, body }) });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ v: 1, totals: { tokens: { total: 0 } } });
                return response.json();
            } });
            const exported = await executor.execute('teams.credentials.usage.export', input, f.context(root));
            expect(exported, JSON.stringify(exported)).toMatchObject({ ok: true, result: { mediaType: 'text/csv' } });
            const path = '/v1/account/encryption/currentness';
            const refused = await f.app.inject({ method: 'GET', url: path,
                headers: await f.headers(root, { effectActionId: 'teams.credentials.usage.query', method: 'GET', path }) });
            expect(refused.statusCode, refused.body).toBe(401);
        } finally { await app.close(); await f.app.close(); }
    });

    it('reads a selected registry app update Environment through its native sibling and refuses a fresh unselected read', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerDeploymentRoutes(app);
        await app.ready();
        try {
            const serverId = await getOrCreateServerIdentityId();
            const source = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Reviewed registry app', audience: [] }));
            if (!source.ok) throw new Error(source.error);
            const content = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Reviewed app' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!content.ok) throw new Error(content.error);
            const data = { projectSourceId: source.source.id, createdByAccountId: f.account.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id,
                contentArtifactId: content.artifact.id, contentHeaderVersion: content.artifact.headerVersion,
                contentBodyVersion: content.artifact.bodyVersion } as const;
            const environment = await db.deploymentEnvironment.create({ data });
            const unselected = await db.deploymentEnvironment.create({ data });
            const input = { kind: 'app', environments: [{ environmentId: environment.id, expectedRevision: environment.revision }] };
            const root = await f.root('registries.updates.check', input);
            for (const [id, status] of [[environment.id, 200], [unselected.id, 401]] as const) {
                const path = `/v1/deployments/environments/${id}?serverId=${serverId}`;
                const response = await app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'deployments.environments.get', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 200) expect(response.json()).toMatchObject({ ok: true, environment: { id: environment.id } });
            }
        } finally { await app.close(); await f.app.close(); }
    });

    it('keeps a publicly minted Doc read child inside its Artifact codec and active anchored Discussion list', async () => {
        const f = await createReviewedChildAuthorizationFixture({ artifactReads: true });
        try {
            const doc = await artifact(f);
            const input = { ref: { kind: 'doc', artifactId: doc.id } };
            const root = await f.root('doc.read', input);
            const parent = { actionId: root.binding.actionId, input };
            expect(await f.child(root, parent, { action: 'artifact.get', role: 'doc-read', input: { artifactId: doc.id } }, async context => {
                for (const [path, status] of [[`/v1/artifacts/${doc.id}`, 200], ['/v1/artifacts', 401]] as const) {
                    const response = await f.app.inject({ method: 'GET', url: path,
                        headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'artifact.get', method: 'GET', path }) });
                    expect(response.statusCode, response.body).toBe(status);
                    if (status === 200) expect(response.json()).toMatchObject({ id: doc.id });
                }
                return { ok: true, result: null };
            })).toMatchObject({ ok: true });
            expect(await f.child(root, parent, { action: 'discussion.list', role: 'doc-counts',
                input: { state: 'active', anchorDocArtifactId: doc.id } }, async context => {
                for (const [selection, status] of [[`state=active&anchorDocArtifactId=${doc.id}`, 200], ['state=active', 401]] as const) {
                    const path = `${DISCUSSION_HTTP_PATHS_V1.collection}?${selection}`;
                    const response = await f.app.inject({ method: 'GET', url: path,
                        headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'discussion.list', method: 'GET', path }) });
                    expect(response.statusCode, response.body).toBe(status);
                }
                return { ok: true, result: null };
            })).toMatchObject({ ok: true });
        } finally { await f.app.close(); }
    });

    it('opens a Doc acceptance preparation through a real Discussion read child and refuses its grant roster', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        try {
            const discussionId = await discussion(f);
            const input = { proposalRef: { kind: 'discussion', discussion: { serverId: await getOrCreateServerIdentityId(), discussionId }, messageId: 'proposal' },
                expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
            const root = await f.root('doc.edit.accept', input);
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'discussion.read', role: 'proposal-read', input: { discussionId } }, async context => {
                    for (const [template, status] of [[DISCUSSION_HTTP_PATHS_V1.discussion, 200], [DISCUSSION_HTTP_PATHS_V1.recipientCensus, 401]] as const) {
                        const path = template.replace(':discussionId', discussionId);
                        const response = await f.app.inject({ method: 'GET', url: path,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'discussion.read', method: 'GET', path }) });
                        expect(response.statusCode, response.body).toBe(status);
                    }
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await f.app.close(); }
    });

    it('posts a Doc comment through its real Discussion child and rejects a freshly signed roster read', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        try {
            const discussionId = await discussion(f);
            const doc = await artifact(f);
            const serverId = await getOrCreateServerIdentityId();
            const input = { target: { ref: { kind: 'doc', artifactId: doc.id, serverId }, revision: { headerVersion: 1, bodyVersion: 1 },
                range: { start: 0, end: 7 }, quote: 'Passage' }, discussionRef: { serverId, discussionId },
                localId: crypto.randomUUID(), content };
            const root = await f.root('doc.comment.reply', input);
            const mutation = prepareDocDiscussionMutationV1('doc.comment.reply', input, serverId);
            if (mutation.actionId !== 'discussion.post') throw new Error('Expected the canonical Doc comment post');
            const body = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: mutation.input.localId,
                content: { t: 'plain', v: mutation.input.content }, authoredContent: mutation.input.content,
                replyTarget: mutation.input.replyTarget, mentionedAccountIds: [] });
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'discussion.post', role: 'doc-comment', input: mutation.input }, async context => {
                    const path = DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId);
                    const response = await f.app.inject({ method: 'POST', url: path, payload: body,
                        headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'discussion.post', method: 'POST', path, body }) });
                    expect(response.statusCode, response.body).toBe(200);
                    const refusedPath = DISCUSSION_HTTP_PATHS_V1.recipientCensus.replace(':discussionId', discussionId);
                    const refused = await f.app.inject({ method: 'GET', url: refusedPath,
                        headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'discussion.post', method: 'GET', path: refusedPath }) });
                    expect(refused.statusCode, refused.body).toBe(401);
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await f.app.close(); }
    });

    it('opens a Second opinion Doc through its actual Artifact child without granting Artifact inventory', async () => {
        const f = await createReviewedChildAuthorizationFixture({ artifactReads: true });
        try {
            const doc = await artifact(f);
            const source = { kind: 'doc_passage', passage: { ref: { kind: 'doc', artifactId: doc.id },
                revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 7 }, quote: 'Passage' } };
            const input = { intent: 'preview', source, title: 'Review', question: 'Check this', reviewers: [],
                retry: { creationLocalId: crypto.randomUUID(), quoteLocalId: crypto.randomUUID(), questionLocalId: crypto.randomUUID() } };
            const root = await f.root('discussion.second_opinion.start', input);
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'artifact.get', role: 'source-doc', input: { artifactId: doc.id } }, async context => {
                    for (const [path, status] of [[`/v1/artifacts/${doc.id}`, 200], ['/v1/artifacts', 401]] as const) {
                        const response = await f.app.inject({ method: 'GET', url: path,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'artifact.get', method: 'GET', path }) });
                        expect(response.statusCode, response.body).toBe(status);
                    }
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await f.app.close(); }
    });

    it('reads Memory exposure through the real grants child and refuses recipient key preparation', async () => {
        const f = await createReviewedChildAuthorizationFixture({ artifactReads: true, publicShares: true });
        try {
            const doc = await artifact(f);
            const input = { ref: { kind: 'doc', artifactId: doc.id }, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, factId: 'fact' };
            const root = await f.root('memory.forget', input);
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'artifact.access.grants.list', role: 'memory-exposure', input: { artifactId: doc.id } }, async context => {
                    for (const [path, status] of [[`/v1/artifacts/${doc.id}/access/grants`, 200],
                        [`/v1/public-shares?subjectKind=artifact&subjectId=${doc.id}`, 200],
                        [`/v1/artifacts/${doc.id}/access/recipients`, 401]] as const) {
                        const response = await f.app.inject({ method: 'GET', url: path,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'artifact.access.grants.list', method: 'GET', path }) });
                        expect(response.statusCode, response.body).toBe(status);
                        if (status === 200 && path.includes('/access/grants')) expect(response.json()).toMatchObject({ artifactId: doc.id, ownerAccountId: f.account.id });
                    }
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await f.app.close(); }
    });

    it('reads Usage export encryption preparation through its real query child without feature inventory', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        try {
            const input = { query: projectNativeJsonValueForTransport(normalizeUsageQuery({})), format: 'json', fields: ['totals'] };
            const root = await f.root('usage.export', input);
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'usage.query', role: 'usage-export-query', input: { queries: [input.query] } }, async context => {
                    for (const [path, status] of [['/v1/account/encryption/currentness', 200], ['/v1/features/authenticated', 401]] as const) {
                        const response = await f.app.inject({ method: 'GET', url: path,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'usage.query', method: 'GET', path }) });
                        expect(response.statusCode, response.body).toBe(status);
                        if (status === 200) expect(response.json()).toMatchObject({ mode: 'plain' });
                    }
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await f.app.close(); }
    });

    it('reads the public-profile owner through its real preparation child and refuses the published view sibling', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerAccountPublicProfileRoutes(app);
        await app.ready();
        try {
            const input = { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {}, query: projectNativeJsonValueForTransport(normalizeUsageQuery({})),
                layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
            const root = await f.root('account.public_profile.preview', input);
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'account.public_profile.get', role: 'profile-owner', input: {} }, async context => {
                    for (const [path, status] of [['/v1/account/public-profile', 200], ['/v1/account/public-profile/view', 401]] as const) {
                        const response = await app.inject({ method: 'GET', url: path,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: 'account.public_profile.get', method: 'GET', path }) });
                        expect(response.statusCode, response.body).toBe(status);
                        if (status === 200) expect(response.json()).toMatchObject({ kind: 'absent' });
                    }
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await app.close(); await f.app.close(); }
    });
}
