import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createSessionAccessFixture, createSessionFixture, createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { storage } from '@/sync/domains/state/storage';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SessionHeaderActionMenu } from './SessionHeaderActionMenu';
import { Modal } from '@/modal';
import { router } from 'expo-router';
import { BotTemplateEditor } from '@/components/sessions/bots/templates/BotTemplateEditor';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

// Presentation/native adapters and HTTP are boundaries; menu, scope, Action and store stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@legendapp/list/react-native', async () => (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let previousState: ReturnType<typeof storage.getState> | undefined;
afterEach(async () => {
    standardCleanup();
    await home?.dispose(); home = undefined;
    if (previousState) storage.setState(previousState, true);
    vi.clearAllMocks();
});

it('deletes only the owner’s template draft after menu confirmation and hides deletion from recipients', async () => {
    previousState = storage.getState();
    home = await createPlainArtifactHomeFixture('https://template-menu-delete.test', { currentAccount: true,
        serverFeatures: createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } } }),
        handleRequest: async path => path === '/v2/account/settings'
            ? Response.json({ content: { t: 'plain', v: {} }, version: 1 }) : null });
    const draftId = 'ed10c191-207e-4076-99e9-8db2f392ae50';
    const releaseId = 'f77c79f3-beb6-4e4b-8e89-5f3957a48589';
    const source = createSessionFixture({ id: 'source', serverId: home.home.id,
        metadata: { bot: { kind: 'bot' }, work: { templateDraftRef: { serverId: home.home.id, artifactId: draftId } } } });
    const content = { v: 1 as const, identity: { name: 'Garden', description: 'Plant care' },
        instructions: { markdown: 'Grow herbs' }, skills: [], memoryRules: [],
        needs: { software: [], connectedAccounts: [], mcpServers: [] } };
    const draft = { v: 1 as const, state: 'draft' as const, sourceSessionRef: { serverId: home.home.id, sessionId: source.id },
        releaseArtifactId: releaseId, content, candidates: { skills: [], memoryRules: [] } };
    const release = { v: 1 as const, state: 'released' as const,
        release: { v: 1 as const, version: '1.0.0', releasedAtMs: 1, changelog: '', content } };
    for (const [id, template] of [[draftId, draft], [releaseId, release]] as const) {
        home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id, title: 'Garden', isDecrypted: true,
            header: projectBotTemplateArtifactHeaderV1(template), body: JSON.stringify(template), access: 'owner', publicAudience: 'none',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'));
    }
    const published = home.boundary.read(releaseId);
    const recipient = { ...source, access: createSessionAccessFixture('admin') };
    storage.setState({ sessions: { [source.id]: recipient } });
    const other = await renderScreen(<SessionHeaderActionMenu sessionId={source.id} session={recipient} />);
    expect(other.findByType(DropdownMenu).props.items.some((item: { id: string }) => item.id === 'header.deleteBotTemplate')).toBe(false);
    await other.unmount();
    storage.setState({ sessions: { [source.id]: source } });
    const screen = await renderScreen(<SessionHeaderActionMenu sessionId={source.id} session={source} />);
    const menu = screen.findByType(DropdownMenu);
    expect(menu.props.items.find((item: { id: string }) => item.id === 'header.deleteBotTemplate')).toMatchObject({ destructive: true });
    let respond: ((confirmed: boolean) => void) | undefined;
    vi.mocked(Modal.confirm).mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    await act(async () => { menu.props.onSelect('header.deleteBotTemplate'); });
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'));
    expect(Modal.confirm).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ destructive: true }));
    expect(home.boundary.read(draftId)).not.toBeNull();
    await act(async () => { respond!(false); });
    expect(home.requests.filter(row => row.method === 'DELETE')).toEqual([]);
    await act(async () => { menu.props.onSelect('header.deleteBotTemplate'); });
    await act(async () => { respond!(true); });
    await vi.waitFor(() => expect(home!.boundary.read(draftId), JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toBeNull());
    expect(home.requests.filter(row => row.method === 'DELETE').map(row => row.path)).toEqual([`/v1/artifacts/${draftId}/revision/1/1`]);
    expect(home.boundary.read(releaseId)).toEqual(published);
    // REAL-USER-PASS-2 G12: deleting from the Bot's own menu keeps the person on that Bot.
    expect(router.replace).not.toHaveBeenCalled();
    await screen.unmount();
    const recovery = await renderScreen(<BotTemplateEditor artifactId={draftId} serverId={home.home.id} sourceSessionId={source.id} />);
    await vi.waitFor(() => expect(recovery.findByType(SurfaceStateCard).props.action?.label).toBe(t('botTemplates.createTemplate')));
    expect(home.boundary.read(releaseId)).toEqual(published);
    await recovery.unmount();
});
