import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateDraftV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { useBotTemplateEditor } from './useBotTemplateEditor';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push } }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { standardCleanup(); await home?.dispose(); home = undefined; });

describe('template pane and page Account buffer', () => {
    it('opens one addressed Artifact and retains the same edits and release selection after presentation transfer', async () => {
        let sourceResponse: ReturnType<typeof createPlainSessionByIdResponseFixture> | undefined;
        const sourceReads = createSessionReadBatchFetchBoundary(async input =>
            new URL(String(input)).pathname === '/v2/sessions/source' && sourceResponse
                ? Response.json(sourceResponse) : null);
        home = await createPlainArtifactHomeFixture('https://template-editor-buffer.test', {
            currentAccount: true,
            handleRequest: async (path, init) => path === '/v2/account/settings'
                ? Response.json({ version: 1, content: { t: 'plain', v: {} } })
                : sourceReads(`https://template-editor-buffer.test${path}`, init),
        });
        await home.hydrateAccountSettings();
        const serverId = home.home.id;
        const artifactId = '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d';
        sourceResponse = createPlainSessionByIdResponseFixture(createSessionFixture({ id: 'source',
            metadata: { path: '/garden', host: 'author', work: { templateDraftRef: { serverId, artifactId } } } }));
        const draft: BotTemplateDraftV1 = { v: 1, state: 'draft', sourceSessionRef: { serverId, sessionId: 'source' },
            releaseArtifactId: '5bdb3f40-e1b4-4e6b-b079-3ae53c6f1db4',
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Original' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
            candidates: { memoryRules: [], skills: [] } };
        home.boundary.replaceStoredRow({ id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', publicAudience: 'none',
            encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(draft)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(draft) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const pane = await renderHook(() => useBotTemplateEditor(artifactId, serverId));
        await expect.poll(() => ({ buffer: pane.getCurrent().buffer, errorCode: pane.getCurrent().errorCode }))
            .toMatchObject({ buffer: expect.objectContaining({ getSnapshot: expect.any(Function) }), errorCode: undefined });
        const buffer = pane.getCurrent().buffer!;
        const reads = home.requests.filter(request => request.method === 'GET' && request.path === `/v1/artifacts/${artifactId}`).length;
        expect(reads).toBeGreaterThan(0);
        await act(async () => {
            buffer.edit(current => ({ ...current, content: { ...current.content, instructions: { markdown: 'Retain me' } } }));
            buffer.editRelease({ version: '2.0.0', changelog: 'A careful edit' });
            buffer.editNeedAuthoring({ open: true, kind: 'mcpServers', name: 'Review helpers', endpoint: 'review-tools' });
        });
        const page = await renderHook(() => useBotTemplateEditor(artifactId, serverId));
        await expect.poll(() => page.getCurrent().buffer).toBe(buffer);
        await pane.unmount();
        expect(page.getCurrent().buffer?.getSnapshot()).toMatchObject({ status: 'unsaved',
            draft: { content: { instructions: { markdown: 'Retain me' } } }, releaseOptions: { version: '2.0.0', changelog: 'A careful edit' },
            needAuthoring: { open: true, kind: 'mcpServers', name: 'Review helpers', endpoint: 'review-tools' } });
        expect(home.requests.filter(request => request.method === 'GET' && request.path === `/v1/artifacts/${artifactId}`)).toHaveLength(reads);
        expect(home.boundary.readPlainBody(artifactId)).toBe(JSON.stringify(draft));
        // Opening publication carries this saved private draft into the same generic
        // publisher. It must not create a release or mutate the author skill library.
        buffer.useRevision({ headerVersion: 1, bodyVersion: 1 });
        const { BotTemplatePublishButton } = await import('./BotTemplatePublishButton');
        const screen = await renderScreen(React.createElement(BotTemplatePublishButton, {
            artifactId, serverId, buffer, save: page.getCurrent().save,
        }));
        await screen.pressByTestIdAsync('bot-template-publish');
        await expect.poll(() => ({ status: buffer.getSnapshot().status, errorCode: buffer.getSnapshot().errorCode }))
            .toEqual({ status: 'saved', errorCode: undefined });
        expect(JSON.parse(home.boundary.readPlainBody(artifactId)!)).toMatchObject({
            content: { instructions: { markdown: 'Retain me' } } });
        await vi.waitFor(() => expect(push).toHaveBeenCalled());
        expect(push.mock.calls.at(-1)?.[0]).toMatchObject({ pathname: '/settings/plugins/publish',
            params: { templateArtifactId: artifactId, templateServerId: serverId } });
        expect(home.boundary.readPlainBody(draft.releaseArtifactId)).toBeNull();
    });
});
