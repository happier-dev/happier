import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act, renderHook } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { BotTemplateReleaseV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { useBotTemplateRecipient } from './useBotTemplateRecipient';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; });

describe('mounted template release reader', () => {
    it('opens one addressed release without creating anything and retains it when an explicit refresh fails', async () => {
        home = await createPlainArtifactHomeFixture('https://template-preview.test', { currentAccount: true });
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '',
            content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
                skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
        const artifact = { v: 1 as const, state: 'released' as const, release };
        home.boundary.replaceStoredRow({ id: 'released-template', ownerAccountId: 'artifact-account', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const source = { kind: 'artifact' as const, serverId: home.home.id, artifactId: 'released-template' };
        const hook = await renderHook(() => useBotTemplateRecipient(source, home!.home.id));
        await vi.waitFor(() => expect(hook.getCurrent().execution.ready).toBe(true));
        await vi.waitFor(() => expect(hook.getCurrent().preview?.release.content.instructions.markdown).toBe('Grow herbs'));
        expect(home.boundary.list()).toHaveLength(1);
        const loaded = hook.getCurrent().preview;
        home.boundary.clear();
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().failed).toBe(true);
        expect(hook.getCurrent().preview).toBe(loaded);
        expect(home.boundary.list()).toHaveLength(0);
        await hook.unmount();
    });
});
import '@/sync/syncEngine';
