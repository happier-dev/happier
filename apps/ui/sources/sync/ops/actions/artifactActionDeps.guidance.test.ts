import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1, createActionExecutor, readLegacyRolesV1 } from '@happier-dev/protocol';
import { BotTemplateArtifactV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

// The third-party markdown renderer is outside this Account/Artifact journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected markdown rendering in Artifact test'); },
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: LazyActionAccountContext | undefined;
afterEach(async () => {
    account?.dispose(); account = undefined;
    await fixture?.dispose(); fixture = undefined;
    vi.restoreAllMocks();
});

describe('UI generic Artifact deletion and current guidance authority', () => {
    it('deletes owned template drafts and releases through the confirmed Action without deleting independent records', async () => {
        fixture = await createPlainArtifactHomeFixture('https://template-delete.test', {
            handleRequest: async path => path === '/v2/account/settings'
                ? Response.json({ content: { t: 'plain', v: {} }, version: 1 }) : null,
        });
        const content = { v: 1, identity: { name: 'Helper', description: 'Reusable helper' }, instructions: { markdown: 'Help with work.' },
            memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } };
        const draftId = '11111111-1111-4111-8111-111111111111';
        const releaseId = '22222222-2222-4222-8222-222222222222';
        const copyId = '33333333-3333-4333-8333-333333333333';
        const draft = BotTemplateArtifactV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId: 'home', sessionId: 'source' },
            releaseArtifactId: releaseId, content, candidates: { memoryRules: [], skills: [] } });
        const release = BotTemplateArtifactV1Schema.parse({ v: 1, state: 'released',
            release: { v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '', content } });
        for (const [id, template] of [[draftId, draft], [releaseId, release], [copyId, release]] as const) {
            await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
                header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(template)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(template) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        }
        const independent = fixture.boundary.read(copyId);
        const released = fixture.boundary.read(releaseId);
        account = await captureLazyActionAccountContext(fixture.home.id);
        const executor = createActionExecutor({ artifactAction: createUiArtifactAction(account) });
        const remove = (artifactId: string) => executor.execute('artifact.delete', {
            artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
        }, { surface: 'ui', authority: 'present_user', bypassApprovals: true, presentUserConfirmation: { actionId: 'artifact.delete' } });
        expect(await remove(draftId)).toMatchObject({ ok: true, result: { artifactId: draftId, deleted: true } });
        expect(fixture.boundary.read(draftId)).toBeNull();
        expect(fixture.boundary.read(releaseId)).toEqual(released);
        expect(await remove(releaseId)).toMatchObject({ ok: true, result: { artifactId: releaseId, deleted: true } });
        expect(fixture.boundary.read(releaseId)).toBeNull();
        expect(fixture.boundary.read(copyId)).toEqual(independent);
    });

    it('deletes unrelated unreadable content without opening its body when current guidance identities are complete', async () => {
        fixture = await createPlainArtifactHomeFixture('https://guidance-unreadable-delete.test', {
            handleRequest: async path => path === '/v2/account/settings'
                ? Response.json({ content: { t: 'plain', v: {} }, version: 7 }) : null,
        });
        await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'unreadable-document', header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Corrupt content' }),
            body: 'invalid retained body envelope', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        account = await captureLazyActionAccountContext(fixture.home.id);
        const result = await createUiArtifactAction(account)({ actionId: 'artifact.delete',
            input: { artifactId: 'unreadable-document', expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
            context: { surface: 'ui', authority: 'present_user' } });
        expect(result).toMatchObject({ artifactId: 'unreadable-document', deleted: true });
        expect(fixture.boundary.read('unreadable-document')).toBeNull();
        expect(fixture.requests.filter(request => request.method === 'GET' && request.path === '/v1/artifacts/unreadable-document')).toEqual([]);
    });

    it('deletes matching current guidance with its Role without importing or changing unrelated entries', async () => {
        const guidance = {
            executionRunsGuidanceEntries: [
                { id: 'current-guidance', description: 'Current guidance Role' },
                { id: 'invalid-without-description' },
            ],
        };
        let raw: Readonly<Record<string, unknown>> = guidance;
        let settingsVersion = 7;
        fixture = await createPlainArtifactHomeFixture('https://guidance-artifact-delete.test', {
            handleRequest: async (path, init) => {
                if (path !== '/v2/account/settings') return null;
                if (init?.method === 'POST') {
                    const request = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    expect(request.expectedVersion).toBe(settingsVersion);
                    if (request.content?.t !== 'plain') throw new Error('Expected Plain Account settings');
                    raw = request.content.v;
                    return Response.json({ success: true, version: ++settingsVersion });
                }
                return Response.json({ content: { t: 'plain', v: raw }, version: settingsVersion });
            },
        });
        const [legacy] = readLegacyRolesV1(raw, 'artifact-account');
        if (!legacy) throw new Error('Expected canonical current guidance identity');
        const [malformedIdentity] = readLegacyRolesV1({ executionRunsGuidanceEntries: [
            { id: 'invalid-without-description', description: 'Previously valid guidance' },
        ] }, 'artifact-account');
        if (!malformedIdentity) throw new Error('Expected canonical retained malformed guidance identity');
        for (const [artifactId, kind, body] of [
            [legacy.artifactId, 'role.v1', JSON.stringify(legacy.role)],
            [malformedIdentity.artifactId, 'role.v1', JSON.stringify(malformedIdentity.role)],
            ['ordinary-document', 'prompt_doc.v2', JSON.stringify({ v: 1, markdown: 'Document', createdAtMs: 1, updatedAtMs: 1 })],
            ['ordinary-role', 'role.v1', JSON.stringify(BUILT_IN_ROLES_V1.builder)],
        ]) await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: artifactId, header: encodePlainArtifactStoredContent({ v: 1, kind, title: 'Stored content' }),
            body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        account = await captureLazyActionAccountContext(fixture.home.id);
        const execute = createUiArtifactAction(account);
        const remove = (artifactId: string) => execute({ actionId: 'artifact.delete',
            input: { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
            context: { surface: 'ui', authority: 'present_user' } });
        expect(await execute({ actionId: 'artifact.delete',
            input: { artifactId: legacy.artifactId, expectedRevision: { headerVersion: 2, bodyVersion: 2 } },
            context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
        expect(raw).toEqual(guidance);
        expect(await remove(legacy.artifactId)).toMatchObject({ artifactId: legacy.artifactId, deleted: true });
        expect(fixture.boundary.read(legacy.artifactId)).toBeNull();
        expect(raw).toEqual({ executionRunsGuidanceEntries: [guidance.executionRunsGuidanceEntries[1]] });
        expect(await remove(malformedIdentity.artifactId)).toMatchObject({ artifactId: malformedIdentity.artifactId, deleted: true });
        expect(raw).toEqual({ executionRunsGuidanceEntries: [] });
        expect(await remove('ordinary-document')).toMatchObject({ artifactId: 'ordinary-document', deleted: true });
        expect(await remove('ordinary-role')).toMatchObject({ artifactId: 'ordinary-role', deleted: true });
        expect(fixture.requests.filter(request => request.method === 'POST' && request.path === '/v1/artifacts')).toHaveLength(0);
    });

    it('refuses Role deletion only when malformed current guidance identities cannot be characterized', async () => {
        fixture = await createPlainArtifactHomeFixture('https://guidance-uncharacterizable-delete.test', {
            handleRequest: async path => path === '/v2/account/settings'
                ? Response.json({ content: { t: 'plain', v: { executionRunsGuidanceEntries: null } }, version: 7 }) : null,
        });
        for (const [artifactId, kind, body] of [
            ['ordinary-role', 'role.v1', JSON.stringify(BUILT_IN_ROLES_V1.builder)],
            ['ordinary-document', 'prompt_doc.v2', JSON.stringify({ v: 1, markdown: 'Document', createdAtMs: 1, updatedAtMs: 1 })],
        ]) await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: artifactId, header: encodePlainArtifactStoredContent({ v: 1, kind, title: 'Stored content' }),
            body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        account = await captureLazyActionAccountContext(fixture.home.id);
        const execute = createUiArtifactAction(account);
        const remove = (artifactId: string) => execute({ actionId: 'artifact.delete',
            input: { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
            context: { surface: 'ui', authority: 'present_user' } });
        expect(await remove('ordinary-role')).toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
        expect(fixture.boundary.read('ordinary-role')).not.toBeNull();
        expect(await remove('ordinary-document')).toMatchObject({ artifactId: 'ordinary-document', deleted: true });
    });
});
