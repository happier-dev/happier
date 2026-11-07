import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { BotTemplateEditor } from './BotTemplateEditor';
import { Modal } from '@/modal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@legendapp/list/react-native', async () => (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; });

async function seedDraft(access: 'owner' | 'view') {
    const draftId = 'ed10c191-207e-4076-99e9-8db2f392ae51';
    home = await createPlainArtifactHomeFixture(`https://template-delete-${access}.test`, { currentAccount: true,
        serverFeatures: createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } } }),
        handleRequest: async path => path === '/v2/account/settings' ? Response.json({ content: { t: 'plain', v: {} }, version: 1 }) : null });
    const draft = { v: 1 as const, state: 'draft' as const, sourceSessionRef: { serverId: home.home.id, sessionId: 'source' },
        releaseArtifactId: 'f77c79f3-beb6-4e4b-8e89-5f3957a48580', content: { v: 1 as const, identity: { name: 'Garden', description: 'Plant care' },
            instructions: { markdown: 'Grow herbs' }, skills: [], memoryRules: [],
            needs: { software: [], connectedAccounts: [], mcpServers: [] } }, candidates: { skills: [], memoryRules: [] } };
    home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: draftId, title: 'Garden', isDecrypted: true,
        header: projectBotTemplateArtifactHeaderV1(draft), body: JSON.stringify(draft), access, publicAudience: 'none',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, ...(access === 'owner' ? {} : { ownerAccountId: 'someone-else' }) },
        'artifact-account'));
    return draftId;
}

describe("the owner's template page", () => {
    // FINAL-QA r29: the owner's expanded template page had no header ⋯ and so no "Delete template…".
    it('offers Delete template… in its header ⋯ and deletes the draft through artifact.delete', async () => {
        const draftId = await seedDraft('owner');
        const screen = await renderScreen(<BotTemplateEditor artifactId={draftId} serverId={home!.home.id} presentation="page" />);
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-editor:more')).not.toBeNull());
        const menu = screen.tree.root.findAll(node => node.type === ItemRowActions
            && node.props.overflowTriggerTestID === 'bot-template-editor:more')[0]!;
        const remove = menu.props.actions.find((action: { id: string }) => action.id === 'bot-template-editor:delete');
        expect(remove).toMatchObject({ destructive: true });
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        await remove.onPress();
        await vi.waitFor(() => expect(home!.boundary.read(draftId), JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toBeNull());
        await screen.unmount();
    });

    it('never shows the owner ⋯ to someone who is not the owner', async () => {
        const draftId = await seedDraft('view');
        const screen = await renderScreen(<BotTemplateEditor artifactId={draftId} serverId={home!.home.id} presentation="page" />);
        // The author editor opens only the owner's draft; anyone else never reaches its header.
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Template unavailable'));
        expect(screen.findByTestId('bot-template-editor:more')).toBeNull();
        await screen.unmount();
    });
});
