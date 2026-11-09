import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplateEditor } from './BotTemplateEditor';
import { ReviewedDocumentShareSheet } from '@/components/sharing/documents/ReviewedDocumentShareSheet';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@legendapp/list/react-native', async () => (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; });

describe('reviewed template release from the editor', () => {
    it('submits the selected Account once without requiring a signed-in link or another review', async () => {
        const draftId = 'ed10c191-207e-4076-99e9-8db2f392ae50';
        const releaseId = 'f77c79f3-beb6-4e4b-8e89-5f3957a48589';
        const account = { id: 'recipient', firstName: 'Ana', lastName: null, username: 'ana', avatar: null,
            bio: null, status: 'none', publicKey: null };
        home = await createPlainArtifactHomeFixture('https://reviewed-template-share.test', { currentAccount: true,
            serverFeatures: createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } } }),
            handleRequest: async path => path.startsWith('/v1/user/search?') ? Response.json({ users: [account], nextCursor: null })
                : path === '/v1/user/recipient' ? Response.json({ user: { ...account,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } }) : null });
        const draft = { v: 1 as const, state: 'draft' as const, sourceSessionRef: { serverId: home.home.id, sessionId: 'source' },
            releaseArtifactId: releaseId, content: { v: 1 as const, identity: { name: 'Garden', description: 'Plant care' },
                instructions: { markdown: 'Grow herbs' }, skills: [], memoryRules: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } }, candidates: { skills: [], memoryRules: [] } };
        home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: draftId, title: 'Garden', isDecrypted: true,
            header: projectBotTemplateArtifactHeaderV1(draft), body: JSON.stringify(draft), access: 'owner', publicAudience: 'none',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'));
        const { ModalProvider } = await import('@/modal');
        const screen = await renderScreen(<ModalProvider><BotTemplateEditor artifactId={draftId} serverId={home.home.id} /></ModalProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-release')).not.toBeNull());
        await screen.pressByTestIdAsync('bot-template-release');
        const sheet = screen.tree.root.findByType(ReviewedDocumentShareSheet);
        const buttonType = Reflect.get(RoundButton, 'type') ?? RoundButton;
        const primaryActions = sheet.findAll(button => button.type === buttonType
            && button.props.display !== 'inverted');
        expect(primaryActions.map(button => button.props.testID)).toEqual(['document-share-submit']);
        const chrome = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].chrome;
        expect(chrome?.kind === 'card' ? chrome.subtitle : undefined).toContain(t('botTemplates.templateSection'));
        expect(screen.getTextContent()).toContain(t('botTemplates.templateSectionDescription', { name: 'Garden' }));
        const search = screen.find(node => node.props.testID === 'document-share-search' && typeof node.props.onFocus === 'function');
        await act(async () => { search.props.onFocus(); });
        await vi.waitFor(() => expect(screen.findByTestId('document-share-candidate-account:recipient')).not.toBeNull());
        await screen.pressByTestIdAsync('document-share-candidate-account:recipient');
        expect(sheet.find(button => button.type === buttonType && button.props.testID === 'document-share-submit').props.disabled).toBe(false);
        expect(home.boundary.readPlainBody(releaseId)).toBeNull();
        await screen.pressByTestIdAsync('document-share-submit');
        await vi.waitFor(() => expect(home!.boundary.readPlainBody(releaseId), JSON.stringify({
            text: screen.getTextContent().slice(-700), requests: home!.requests.map(row => ({ method: row.method, path: row.path })),
        })).not.toBeNull());
        expect(home.boundary.readGrants(releaseId)).toMatchObject([{ principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view' }]);
        expect(home.requests.filter(request => request.path === '/v1/artifacts' && request.method === 'POST')).toHaveLength(1);
        expect(home.requests.filter(request => request.path.includes('artifact-signed-in-links'))).toEqual([]);
        await screen.unmount();
    });
});
