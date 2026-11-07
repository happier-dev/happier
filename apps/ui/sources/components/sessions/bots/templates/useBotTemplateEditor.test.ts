import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateDraftV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { useBotTemplateEditor } from './useBotTemplateEditor';
import { publishHomeAccountChangeWake } from '@/sync/runtime/orchestration/homeAccountChange';
import { BOT_TEMPLATE_ACTION_IDS_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { t } from '@/text';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push } }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { standardCleanup(); await home?.dispose(); home = undefined; });

describe('template pane and page Account buffer', () => {
    it('keeps dirty Publish saves under the invoking agent policy while UI Publish still saves and opens', async () => {
        push.mockClear();
        const serverUrl = 'https://template-publish-invocation.test';
        const serverIdentityId = 'srv_template_publish';
        const artifactId = '18cc7cc8-6742-415c-a628-c80fb4cd19ca';
        const draftActionId = BOT_TEMPLATE_ACTION_IDS_V1[0];
        const settings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { [draftActionId]: { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { [draftActionId]: ['ui'] },
        }) };
        let sourceResponse: ReturnType<typeof createPlainSessionByIdResponseFixture> | undefined;
        const sourceReads = createSessionReadBatchFetchBoundary(async input =>
            new URL(String(input)).pathname === '/v2/sessions/source' && sourceResponse ? Response.json(sourceResponse) : null);
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({ descriptor: { serverUrl, homeServerIdentityId: serverIdentityId, displayName: 'Publish' },
            source: 'manual', suggestedName: 'Publish' });
        const features = createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } },
            capabilities: { serverIdentity: { serverIdentityId } } });
        home = await createPlainArtifactHomeFixture(serverUrl, { currentAccount: true, serverFeatures: features,
            handleRequest: async (path, init) => path === '/v1/features/authenticated' ? Response.json(features)
                : path === '/v2/account/settings' ? Response.json({ version: 1, content: { t: 'plain', v: settings } })
                    : sourceReads(`${serverUrl}${path}`, init) });
        await home.hydrateAccountSettings();
        const serverId = home.home.id;
        sourceResponse = createPlainSessionByIdResponseFixture(createSessionFixture({ id: 'source',
            metadata: { path: '/garden', host: 'author', work: { templateDraftRef: { serverId, artifactId } } } }));
        const draft: BotTemplateDraftV1 = { v: 1, state: 'draft', sourceSessionRef: { serverId, sessionId: 'source' },
            releaseArtifactId: '08798d24-e9f7-4d6d-855d-400acfcf0296',
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Original' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
            candidates: { memoryRules: [], skills: [] } };
        home.boundary.replaceStoredRow({ id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', publicAudience: 'none',
            encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(draft)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(draft) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const { BotTemplatePublishButton } = await import('./BotTemplatePublishButton');
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        let editor: ReturnType<typeof useBotTemplateEditor> | undefined;
        function Editor() {
            editor = useBotTemplateEditor(artifactId, serverId);
            return editor.buffer ? React.createElement(BotTemplatePublishButton, { artifactId, serverId,
                buffer: editor.buffer, save: editor.save }) : null;
        }
        const screen = await renderMountedCurrentUiContext(React.createElement(Editor));
        await vi.waitFor(() => expect(editor?.buffer).toBeTruthy());
        const buffer = editor!.buffer!;
        await act(async () => { buffer.edit(current => ({ ...current, content: { ...current.content,
            instructions: { markdown: 'Private changes' } } })); });
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const command = await vi.waitFor(() => {
            const selected = readCurrentUiContextActionReader({ surface: 'agent' })?.readCurrentUiContext()?.commands
                .find(row => row.title === t('botTemplates.publishEllipsis'));
            expect(selected).toBeDefined();
            return selected!;
        });
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => { await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command.id }, {
            surface: 'agent', authority: 'account_automation', expectedAccountId: 'artifact-account', serverId,
            actionRequestId: 'template-publish-dirty-agent',
        }); });
        expect(buffer.getSnapshot()).toMatchObject({ status: 'failed', errorCode: 'action_disabled' });
        expect(JSON.parse(home.boundary.readPlainBody(artifactId)!)).toMatchObject({ content: { instructions: { markdown: 'Original' } } });
        expect(push).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('bot-template-publish');
        await vi.waitFor(() => expect(buffer.getSnapshot().status).toBe('saved'));
        expect(JSON.parse(home.boundary.readPlainBody(artifactId)!)).toMatchObject({ content: { instructions: { markdown: 'Private changes' } } });
        expect(push).toHaveBeenCalled();
    });

    it('follows pushed and reopened clean revisions while retaining dirty pane/page edits and CAS recovery', async () => {
        let sourceResponse: ReturnType<typeof createPlainSessionByIdResponseFixture> | undefined;
        const sourceReads = createSessionReadBatchFetchBoundary(async input =>
            new URL(String(input)).pathname === '/v2/sessions/source' && sourceResponse
                ? Response.json(sourceResponse) : null);
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({ descriptor: { serverUrl: 'https://template-editor-buffer.test',
            homeServerIdentityId: 'srv_template_editor', displayName: 'Editor' }, source: 'manual', suggestedName: 'Editor' });
        const features = createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } },
            capabilities: { serverIdentity: { serverIdentityId: 'srv_template_editor' } } });
        home = await createPlainArtifactHomeFixture('https://template-editor-buffer.test', {
            currentAccount: true,
            serverFeatures: features,
            handleRequest: async (path, init) => path === '/v1/features/authenticated' ? Response.json(features)
                : path === '/v2/account/settings'
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
        let pane = await renderHook(() => useBotTemplateEditor(artifactId, serverId));
        await expect.poll(() => ({ buffer: pane.getCurrent().buffer, errorCode: pane.getCurrent().errorCode }))
            .toMatchObject({ buffer: expect.objectContaining({ getSnapshot: expect.any(Function) }), errorCode: undefined });
        const buffer = pane.getCurrent().buffer!;
        let redraft = { ...draft, content: { ...draft.content, instructions: { markdown: 'Bot redrafted this' } } };
        const stored = home.boundary.read(artifactId)!;
        home.boundary.replaceStoredRow({ ...stored, headerVersion: 2, bodyVersion: 2,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(redraft) }) });
        await act(async () => {
            publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: [artifactId] }, 'socket');
        });
        await expect.poll(() => buffer.getSnapshot()).toMatchObject({ status: 'saved', revision: { headerVersion: 2, bodyVersion: 2 },
            draft: { content: { instructions: { markdown: 'Bot redrafted this' } } } });
        await pane.unmount();
        redraft = { ...redraft, content: { ...redraft.content, instructions: { markdown: 'Redrafted while closed' } } };
        home.boundary.replaceStoredRow({ ...stored, headerVersion: 3, bodyVersion: 3,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(redraft) }) });
        pane = await renderHook(() => useBotTemplateEditor(artifactId, serverId));
        await expect.poll(() => pane.getCurrent().buffer?.getSnapshot()).toMatchObject({ status: 'saved',
            revision: { headerVersion: 3, bodyVersion: 3 }, draft: { content: { instructions: { markdown: 'Redrafted while closed' } } } });
        expect(pane.getCurrent().buffer).toBe(buffer);
        redraft = { ...redraft, content: { ...redraft.content, instructions: { markdown: 'Retry reads current' } } };
        home.boundary.replaceStoredRow({ ...stored, headerVersion: 4, bodyVersion: 4,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(redraft) }) });
        await act(async () => { pane.getCurrent().retry(); });
        await expect.poll(() => buffer.getSnapshot()).toMatchObject({ revision: { headerVersion: 4, bodyVersion: 4 },
            draft: { content: { instructions: { markdown: 'Retry reads current' } } } });
        const reads = home.requests.filter(request => request.method === 'GET' && request.path === `/v1/artifacts/${artifactId}`).length;
        expect(reads).toBeGreaterThan(0);
        await act(async () => {
            publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: ['another-template'] }, 'socket');
            publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['session'], entityIds: ['source'] }, 'socket');
        });
        expect(home.requests.filter(request => request.method === 'GET' && request.path === `/v1/artifacts/${artifactId}`)).toHaveLength(reads);
        await act(async () => {
            buffer.edit(current => ({ ...current, content: { ...current.content, instructions: { markdown: 'Retain me' } } }));
            buffer.editRelease({ version: '2.0.0', changelog: 'A careful edit' });
            buffer.editNeedAuthoring({ open: true, kind: 'mcpServers', name: 'Review helpers', endpoint: 'review-tools' });
            redraft = { ...redraft, content: { ...redraft.content, instructions: { markdown: 'Concurrent Bot redraft' } } };
            home!.boundary.replaceStoredRow({ ...stored, headerVersion: 5, bodyVersion: 5,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(redraft) }) });
            publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['artifact'], entityIds: [artifactId] }, 'socket');
        });
        const page = await renderHook(() => useBotTemplateEditor(artifactId, serverId));
        await expect.poll(() => page.getCurrent().buffer).toBe(buffer);
        await pane.unmount();
        expect(page.getCurrent().buffer?.getSnapshot()).toMatchObject({ status: 'unsaved',
            revision: { headerVersion: 4, bodyVersion: 4 },
            draft: { content: { instructions: { markdown: 'Retain me' } } }, releaseOptions: { version: '2.0.0', changelog: 'A careful edit' },
            needAuthoring: { open: true, kind: 'mcpServers', name: 'Review helpers', endpoint: 'review-tools' } });
        expect(home.requests.filter(request => request.method === 'GET' && request.path === `/v1/artifacts/${artifactId}`)).toHaveLength(reads);
        expect(home.boundary.readPlainBody(artifactId)).toBe(JSON.stringify(redraft));
        // Opening publication carries this saved private draft into the same generic
        // publisher. It must not create a release or mutate the author skill library.
        await act(async () => { await buffer.commit(page.getCurrent().save); });
        expect(buffer.getSnapshot()).toMatchObject({ status: 'conflict', errorCode: 'version_mismatch',
            draft: { content: { instructions: { markdown: 'Retain me' } } } });
        buffer.useRevision({ headerVersion: 5, bodyVersion: 5 });
        const { BotTemplatePublishButton } = await import('./BotTemplatePublishButton');
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const screen = await renderMountedCurrentUiContext(React.createElement(BotTemplatePublishButton, {
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
        await page.unmount();
    });
});
