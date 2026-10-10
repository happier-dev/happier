import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1, readLegacyRolesV1 } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';

// The third-party markdown renderer is outside this Account/Artifact journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected markdown rendering in Artifact test'); },
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: LazyActionAccountContext | undefined;
afterEach(() => {
    account?.dispose(); account = undefined;
    fixture?.dispose(); fixture = undefined;
    vi.restoreAllMocks();
});

describe('UI generic Artifact deletion and current guidance authority', () => {
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

    it('preserves a current guidance Role without importing or blocking unrelated documents', async () => {
        const guidance = {
            executionRunsGuidanceEntries: [
                { id: 'current-guidance', description: 'Current guidance Role' },
                { id: 'invalid-without-description' },
            ],
        };
        let raw: Readonly<Record<string, unknown>> = guidance;
        let settingsVersion = 7;
        fixture = await createPlainArtifactHomeFixture('https://guidance-artifact-delete.test', {
            handleRequest: async path => path === '/v2/account/settings'
                ? new Response(JSON.stringify({ content: { t: 'plain', v: raw }, version: settingsVersion }), { status: 200 }) : null,
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
        expect(await remove(legacy.artifactId)).toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
        expect(fixture.boundary.read(legacy.artifactId)).not.toBeNull();
        expect(await remove(malformedIdentity.artifactId)).toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
        expect(fixture.boundary.read(malformedIdentity.artifactId)).not.toBeNull();
        expect(await remove('ordinary-document')).toMatchObject({ artifactId: 'ordinary-document', deleted: true });
        expect(await remove('ordinary-role')).toMatchObject({ artifactId: 'ordinary-role', deleted: true });
        // The same captured Account now observes the acknowledged current-source cleanup.
        raw = {};
        settingsVersion = 8;
        expect(await remove(malformedIdentity.artifactId)).toMatchObject({ artifactId: malformedIdentity.artifactId, deleted: true });
        expect(await remove(legacy.artifactId)).toMatchObject({ artifactId: legacy.artifactId, deleted: true });
        expect(fixture.boundary.read(legacy.artifactId)).toBeNull();
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
