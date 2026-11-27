import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StorageInventoryItemV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { StorageSpecimen } from '@/components/dev/storage/StorageSpecimen';
import { invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';

import { DiscussionStoragePane, useDiscussionStorageRead } from './discussion/DiscussionStorage';
import type { DiscussionStorageMessage } from './discussion/discussionStorageMessages';

const router = vi.hoisted(() => ({ push: vi.fn(), pathname: '/settings/storage' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({ pathname: () => router.pathname });
    router.push = mock.spies.push;
    return mock.module;
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const accountId = 'owner';
const discussionId = 'discussion-1';
const messageId = 'message-2';
const blobId = '44444444-4444-4444-8444-000000000001';
const fileName = 'checkout.log';
const attachment: StorageInventoryItemV1 = {
    id: blobId, kind: 'discussionAttachments', storedSizeBytes: 120, createdAt: 1, viewerMayRemove: false,
    location: { kind: 'discussion', discussionId, messageId, attachmentId: blobId },
};
const message: DiscussionStorageMessage = {
    id: messageId, authorAccountId: 'sender', accountActor: null, createdAt: 1,
    content: { v: 1, parts: [{ t: 'attachment', attachment: { id: blobId, kind: 'file', name: fileName,
        file: { blobId, mime: 'text/plain', sizeBytes: 120, sha256: 'a'.repeat(64) } } }] },
};

const initialState = getStorage().getState();
let home: Awaited<ReturnType<typeof serveActionHomes>>;
beforeEach(async () => {
    home = await serveActionHomes({
        homes: [{ key: 'owner', serverUrl: 'https://storage-row-commands.test', accountId, currentAccount: true }],
        route: request => {
            if (request.path === '/v1/artifacts/s2') return Response.json({
                id: 's2', ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ title: 'Q4 launch plan' }),
                body: encodePlainArtifactStoredContent({ body: 'Current plan' }),
                headerVersion: 1, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1,
            });
            if (request.path === '/v1/artifacts/s2/revisions') return Response.json({ retentionCount: 10, revisions: [
                { bodyVersion: 2, createdAt: 1, sizeBytes: 14, body: encodePlainArtifactStoredContent({ body: 'Retained plan' }) },
            ] });
            if (request.path === '/v1/artifacts/storage/usage') return Response.json({
                totalBytes: 120, artifactLimitBytes: null, unmeasuredKinds: [],
                byKind: { artifacts: 0, pluginArtifacts: 0, discussionAttachments: 120, accountPets: 0, pluginCollections: 0 },
                kinds: { discussionAttachments: { storedSizeBytes: 120, itemCount: 1 } }, page: { items: [attachment] },
            });
        },
    });
    await home.restoreActiveConnection();
});

afterEach(async () => {
    await act(async () => { Modal.hideAll(); });
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    getStorage().setState(initialState, true);
    router.pathname = '/settings/storage';
    router.push.mockClear();
});

function Publication() {
    const commands = useCurrentUiContextComposedCommands();
    usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
    return null;
}

function DiscussionPane() {
    const scope = captureActiveServerAccountScopeLifetime()!.scope;
    const read = useDiscussionStorageRead(scope, discussionId);
    return <DiscussionStoragePane read={read} source={{ scope, discussionId, ownerAccountId: 'sender', title: 'Checkout',
        messages: LOADED_MESSAGES, authorLabel: () => 'Sender' }} />;
}
const LOADED_MESSAGES = [message];

function StorageCommands({ children }: React.PropsWithChildren) {
    return <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <Publication />
        {children}
    </CurrentUiContextCommandsProvider>;
}

function mount(children: React.ReactNode) {
    return renderMountedCurrentUiContext(<StorageCommands>{children}</StorageCommands>, { withModalProvider: true });
}

type Screen = Awaited<ReturnType<typeof mount>>;
async function layout(screen: Screen, collection: string) {
    const stage = `${collection}:stage`;
    await vi.waitFor(() => expect(screen.findHostByTestId(stage)).not.toBeNull());
    await act(async () => {
        invokeTestInstanceHandler(screen.findHostByTestId(stage), 'onLayout',
            { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 820 } } });
    });
}

async function selectRowAction(screen: Screen, testId: string, id: string) {
    const menu = () => screen.findAllByTestId(testId).at(0)?.findAll(node => node.props.triggerIcon === 'more'
        && Array.isArray(node.props.items) && typeof node.props.onSelect === 'function').at(0);
    await vi.waitFor(() => expect(menu()?.props.items).toContainEqual(expect.objectContaining({ id })));
    await act(async () => { invokeTestInstanceHandler(menu()!, 'onSelect', id); });
}

function agentActions() {
    const executor = createDefaultActionExecutor();
    const caller = { surface: 'agent' as const, authority: 'account_automation' as const,
        serverId: captureActiveServerAccountScopeLifetime()!.scope.serverId };
    return {
        async read() {
            const read = await executor.execute('ui.current_context.read', {}, caller);
            if (!read.ok) throw new Error('Current UI context is unavailable');
            return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
        },
        async invoke(commandId: string) {
            return executor.execute('ui.current_context.command.invoke', { commandId }, caller);
        },
    };
}

it('opens the same Artifact History from the Account Storage row menu and current UI command', async () => {
    const screen = await mount(<StorageSpecimen state="unknown" />);
    await layout(screen, 'storage:collection');
    const row = 'storage:item:artifactOldVersions-s2';
    const modal = () => screen.findByTestId('artifact-history-modal');
    const revisions = () => home.requests.filter(request => request.path === '/v1/artifacts/s2/revisions');
    expect(revisions()).toHaveLength(0);
    await selectRowAction(screen, row, 'history');
    await vi.waitFor(() => expect(modal()).not.toBeNull());
    await vi.waitFor(() => expect(revisions().length).toBeGreaterThan(0));
    await act(async () => { Modal.hideAll(); });
    const menuReadCount = revisions().length;

    const actions = agentActions();
    const commands = (await actions.read()).filter(command => command.title === t('artifacts.browser.storageView.items.showOldVersions'));
    expect(commands.filter(command => command.description === 'Q4 launch plan')).toHaveLength(2);
    expect(commands.some(command => command.description === t('artifacts.browser.storageView.items.nameNotReadable'))).toBe(false);
    await act(async () => { expect(await actions.invoke(commands.find(command => command.description === 'Q4 launch plan')!.id)).toMatchObject({ ok: true }); });
    expect(modal()).not.toBeNull();
    await vi.waitFor(() => expect(revisions().length).toBeGreaterThan(menuReadCount));
    await screen.unmount();
});

it.each([
    { view: 'Account', pathname: '/settings/storage', collection: 'storage:collection',
        row: 'storage:item:discussionAttachments-blob-trace', name: 'api-trace-export.har',
        discussionId: 'specimen-planning', messageId: 'specimen-trace' },
    { view: 'Discussion', pathname: `/discussions/${discussionId}`, collection: 'storage:discussion:files',
        row: `storage:discussion:file:${blobId}`, name: fileName, discussionId, messageId },
])('opens the same anchored message from $view Storage by row menu and current UI command', async (fixture) => {
    router.pathname = fixture.pathname;
    const screen = await mount(fixture.view === 'Account' ? <StorageSpecimen state="settings" /> : <DiscussionPane />);
    await layout(screen, fixture.collection);
    await selectRowAction(screen, fixture.row, 'show');
    const target = router.push.mock.calls.at(-1)?.[0];
    expect(target).toEqual(expect.stringContaining(fixture.discussionId));
    expect(target).toEqual(expect.stringContaining(fixture.messageId));
    const actions = agentActions();
    const command = (await actions.read()).find(command => command.title === t('artifacts.browser.storageView.discussion.showInMessage')
        && command.description === fixture.name);
    expect(command).toBeDefined();
    router.push.mockClear();
    await act(async () => { expect(await actions.invoke(command!.id)).toMatchObject({ ok: true }); });
    expect(router.push).toHaveBeenCalledWith(target);
    await screen.update(<><StorageCommands /></>);
    expect((await actions.read()).some(candidate => candidate.id === command!.id)).toBe(false);
    router.push.mockClear();
    expect(await actions.invoke(command!.id)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(router.push).not.toHaveBeenCalled();
    await screen.unmount();
});
