import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from '@/modal';
import { createDeferred, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListAcceptedWorkspaceRef } from '@/sync/domains/session/sessionAcceptedWorkspace';
import * as sessionPages from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { storage } from '@/sync/domains/state/storage';
import { createPluginActionInputSelectionHostApiHandler } from './pluginActionInputSelectionHostApi';
import type { PluginUiHostApiRequestEnvelopeV1, PluginUiSelectActionInputRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { selectTriageSendRecipientV1 } from '../../../../../../packages/plugins/triage/src/sessions/entryStartChoices';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const viewport = vi.hoisted(() => ({ reachEnd: undefined as (() => void) | undefined }));
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true }, state => {
        viewport.reachEnd = () => state.props?.onEndReached?.();
    });
});

const initialStorage = storage.getState();
afterEach(() => {
    standardCleanup();
    storage.setState(initialStorage, true);
    vi.restoreAllMocks();
});

it('opens Send before any exact read and keeps the first eligible page selectable while the next is pending', async () => {
    const controller = new AbortController();
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' } as const;
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    const checkout = { id: 'checkout', serverId: scope.serverId, machineId: 'machine-a', rootPath: '/qa',
        createdAtMs: 1, projectKey: 'project', repositoryIdentity: repository };
    storage.setState({ profileScope: scope });
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [checkout, { ...checkout, id: 'wrong', rootPath: '/wrong',
            repositoryIdentity: { ...repository, repository: 'happier-dev/another-repo' } }],
        relationships: [], organizations: [], revisionsByPhysicalKey: {},
    });
    function row(id: string, name: string, path: string, viewOnly = false) {
        return buildSessionListRenderableFromSession(createSessionFixture({ id, serverId: scope.serverId,
            ownerAccountId: scope.accountId, access: createSessionAccessFixture(viewOnly ? 'view' : 'owner'),
            metadata: { name, path, host: 'qa', machineId: 'machine-a', workspaceId: path === '/qa' ? 'checkout' : 'wrong' },
        }));
    }
    const rows = {
        first: row('first', 'Eligible first Session', '/qa'),
        wrong: row('wrong', 'Wrong repository Session', '/wrong'),
        viewer: row('viewer', 'View-only Session', '/qa', true),
    };
    expect(readSessionListAcceptedWorkspaceRef(rows.first, scope, storage.getState())).toEqual(checkout);
    storage.setState({ sessionListRowsByServerId: { [scope.serverId]: rows } });
    const pageOne = { current: true, source: 'v2', sessionIds: ['first', 'wrong', 'viewer'],
        nextCursor: 'next', hasNext: true, attentionHasNext: false, attentionNextCursor: null } as const;
    const lastPage = { ...pageOne, sessionIds: [], hasNext: false, nextCursor: null };
    const firstPage = createDeferred<Awaited<ReturnType<typeof sessionPages.fetchSessionListQueryPageForHome>>>();
    const nextPage = createDeferred<typeof lastPage>();
    const pageReads = vi.spyOn(sessionPages, 'fetchSessionListQueryPageForHome').mockImplementation(async (_home, page) =>
        page.cursor ? nextPage.promise : firstPage.promise);
    const exactRead = vi.fn(async () => null);

    const request: Omit<PluginUiHostApiRequestEnvelopeV1, 'payload'> = { version: 1, requestId: 'triage-recipient',
        surface: { pluginId: 'happier.triage', contributionId: 'triage', surfaceId: 'app', placement: 'appSurface',
            platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
        method: 'selectActionInput' };
    const lifetime = { scope, isCurrent: () => !controller.signal.aborted,
        onRetire: () => ({ dispose() {} }) };
    const select = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: scope.serverId, machineId: 'machine-a', targetPluginId: 'happier.triage', accountLifetime: lifetime,
        signal: controller.signal,
    }, isCurrent: lifetime.isCurrent });
    const shown = createDeferred<Parameters<typeof Modal.show>[0]>();
    vi.spyOn(Modal, 'show').mockImplementation(config => { shown.resolve(config); return 'picker'; });
    vi.spyOn(Modal, 'hide').mockImplementation(() => {});
    const host = {
        executeAction: vi.fn(),
        readSession: exactRead,
        selectActionInput: async (payload: PluginUiSelectActionInputRequestV1) => select({ ...request, payload }),
    } as unknown as Parameters<typeof selectTriageSendRecipientV1>[0];
    const pending = selectTriageSendRecipientV1(host, { action: { workspaceMode: 'repository', profileId: null }, repository },
        { signal: controller.signal });
    try {
        const chooser = await Promise.race([shown.promise, pending.then(() => {
            throw new Error('The host settled selection before presenting the picker');
        })]);
        expect(pageReads.mock.calls.length).toBeLessThanOrEqual(1);
        expect(exactRead).not.toHaveBeenCalled();
        const screen = await renderScreen(React.createElement(chooser.component, {
            ...chooser.props, onClose: () => {}, onRequestClose: () => {},
        }));
        await vi.waitFor(() => expect(pageReads).toHaveBeenCalledExactlyOnceWith(scope.serverId,
            expect.objectContaining({ hydration: 'inline', cursor: null })));
        await React.act(async () => firstPage.resolve({ ...pageOne, sessionIds: [...pageOne.sessionIds] }));
        expect(screen.getTextContent()).toContain('Eligible first Session');
        expect(screen.getTextContent()).not.toMatch(/Wrong repository Session|View-only Session/);
        await React.act(async () => viewport.reachEnd?.());
        expect(pageReads).toHaveBeenCalledTimes(2);
        expect(exactRead).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('transcript-send-to-session-option-first');
        expect(await pending).toEqual({ kind: 'sessionAddress', session: { ...{ serverId: scope.serverId }, sessionId: 'first' } });
    } finally {
        await React.act(async () => {
            controller.abort();
            firstPage.resolve(lastPage);
            nextPage.resolve(lastPage);
            await pending;
        });
    }
});
