import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateDraftV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { createBotTemplateEditorBuffer } from '@/components/sessions/bots/templates/botTemplateEditorBuffer';
import { useBotTemplatePublicationSeed } from './useBotTemplatePublicationSeed';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { standardCleanup(); await home?.dispose(); home = undefined; });

describe('Bot publication seed from the original Account', () => {
    it.each(['existing', 'missing', 'unavailable'] as const)('opens %s release bytes without creating a release', async mode => {
        let unavailable = mode === 'unavailable';
        home = await createPlainArtifactHomeFixture(`https://publication-seed-${mode}.test`, { currentAccount: true,
            handleRequest: async path => unavailable && path.startsWith('/v1/artifacts')
                // A settled read refusal exercises explicit Retry without the transport's transient backoff.
                ? Response.json({ error: 'unavailable' }, { status: 400 }) : null });
        const binding = await resolveServerCredentialAccountScope(home.home.id);
        if (binding.kind !== 'bound') throw new Error('Expected original Account binding');
        const draft: BotTemplateDraftV1 = { v: 1, state: 'draft',
            sourceSessionRef: { serverId: home.home.id, sessionId: 'source' },
            releaseArtifactId: '5bdb3f40-e1b4-4e6b-b079-3ae53c6f1db4', candidates: { memoryRules: [], skills: [] },
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Grow herbs' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
        const release = { v: 1 as const, version: '1.0.0', changelog: '', releasedAtMs: 123, content: draft.content };
        const artifact = { v: 1 as const, state: 'released' as const, release };
        if (mode !== 'missing') home.boundary.replaceStoredRow({ id: draft.releaseArtifactId,
            ownerAccountId: 'artifact-account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 2, bodyVersion: 3 } });
        const hook = await renderHook(() => useBotTemplatePublicationSeed({
            artifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d', buffer, scope: binding.scope,
        }));
        if (mode === 'unavailable') {
            await vi.waitFor(() => expect(hook.getCurrent().failed).toBe(true));
            expect(hook.getCurrent().seed).toBeNull();
            unavailable = false;
            await act(async () => { hook.getCurrent().retry(); });
        }
        await vi.waitFor(() => expect(hook.getCurrent().seed).not.toBeNull());
        const seed = hook.getCurrent().seed!;
        expect(seed.previousRelease).toEqual(mode === 'missing' ? null : release);
        expect(seed.botTemplate).toMatchObject({ draftArtifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d',
            expectedRevision: { headerVersion: 2, bodyVersion: 3 }, release: { content: draft.content } });
        expect(seed.botTemplate.release.releasedAtMs).toBeGreaterThan(release.releasedAtMs);
        expect(home.boundary.list()).toHaveLength(mode === 'missing' ? 0 : 1);
        if (mode !== 'missing') expect(home.boundary.readPlainBody(draft.releaseArtifactId)).toBe(JSON.stringify(artifact));
        expect(buffer.getSnapshot().status).toBe('saved');
    });
});
