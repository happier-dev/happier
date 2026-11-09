import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkBoardItemKeyV1, createWorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { BoardCard } from '../model/boardCards';
import { BoardSettingsButton } from './BoardSettingsPopover';
import { Switch } from '@/components/ui/forms/Switch';
import { act } from 'react-test-renderer';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Modal } from '@/modal';
import { useDispatchWorkBoardIntent, useWorkBoardSaveState } from '../model/useWorkBoards';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildWorkBoardArtifactHeaderV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

// The renderer has no layout engine; only the physical anchor is supplied.
const layout = { createNodeMock: () => ({
    getBoundingClientRect: () => ({ left: 100, top: 50, right: 180, bottom: 82, width: 80, height: 32 }),
    measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(100, 50, 80, 32),
}) };

describe('Board settings picked items', () => {
    it('deletes the exact reviewed Board through the shared save queue without another default question', async () => {
        const board = createWorkBoardV1({ id: 'reviewed-board', name: 'Delete me' });
        const home = await createPlainArtifactHomeFixture('https://board-reviewed-delete.test', { accountId: 'owner', currentAccount: true,
            handleRequest: async path => path === '/v2/account/settings'
                ? Response.json({ content: { t: 'plain', v: {} }, version: 0 }) : null });
        home.boundary.replaceStoredRow({ id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        let dispatch: ReturnType<typeof useDispatchWorkBoardIntent> | undefined;
        function Queue() { dispatch = useDispatchWorkBoardIntent(); return null; }
        try {
            await renderScreen(<InjectedAuthProvider credentials={credentials}><Queue /></InjectedAuthProvider>);
            let outcome: Awaited<ReturnType<NonNullable<typeof dispatch>>> | undefined;
            await act(async () => { outcome = await dispatch!({ kind: 'delete', boardId: board.id }, { confirmed: true }); });
            expect(confirmation, JSON.stringify(outcome)).not.toHaveBeenCalled();
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'applied' });
            expect(home.boundary.read(board.id)).toBeNull();
            expect(home.requests.filter(request => request.method === 'DELETE' && request.path.startsWith(`/v1/artifacts/${board.id}`)))
                .toHaveLength(1);
        } finally { await standardCleanup(); await home.dispose(); confirmation.mockRestore(); }
    });

    it.each(['applied', 'refused', 'canceled'] as const)('settles a confirmed delete through the Action before leaving (%s)', async disposition => {
        const board = createWorkBoardV1({ id: 'delete-board', name: 'Delete me' });
        const home = await createPlainArtifactHomeFixture('https://board-delete.test', { accountId: 'owner', currentAccount: true,
            handleRequest: async (path, init) => {
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
                if (path.startsWith(`/v1/artifacts/${board.id}`) && init?.method === 'DELETE' && disposition === 'refused')
                    return Response.json({ error: 'artifact_access_denied' }, { status: 403 });
                return null;
            },
        });
        home.boundary.replaceStoredRow({ id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(disposition !== 'canceled');
        let departures = 0;
        let leftBeforeAcknowledgement = false;
        let saveState: ReturnType<typeof useWorkBoardSaveState> | undefined;
        function Settings() {
            const dispatch = useDispatchWorkBoardIntent();
            saveState = useWorkBoardSaveState();
            return <BoardSettingsButton board={board}
                homes={{ activeServerId: home.home.id, mountedServerIds: [home.home.id], isHomeMounted: () => true }}
                pickedCards={[]} canvasAvailable dispatch={dispatch} onRemoveItem={() => {}}
                onDeleted={() => { departures++; leftBeforeAcknowledgement = home.boundary.read(board.id) !== null; }}
                open onOpenChange={() => {}} onAddByHand={() => {}} />;
        }
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Settings /></InjectedAuthProvider>, layout);
            await screen.pressByTestIdAsync('board-settings.delete');
            await waitForHomeGovernance(() => {
                if (disposition === 'applied') expect(home.boundary.read(board.id)).toBeNull();
                else if (disposition === 'refused') expect(saveState?.failure).toMatchObject({ intent: { kind: 'delete', boardId: board.id }, reason: 'unavailable' });
                else expect(confirmation).toHaveBeenCalledTimes(1);
            });
            expect(confirmation).toHaveBeenCalledTimes(1);
            expect(departures).toBe(disposition === 'applied' ? 1 : 0);
            expect(leftBeforeAcknowledgement).toBe(false);
            expect(home.requests.filter(request => request.method === 'DELETE' && request.path.startsWith(`/v1/artifacts/${board.id}`)))
                .toHaveLength(disposition === 'canceled' ? 0 : 1);
            if (disposition !== 'applied') expect(home.boundary.read(board.id)).not.toBeNull();
        } finally { await standardCleanup(); await home.dispose(); confirmation.mockRestore(); }
    });
    it('keeps settings short and removes picks through a separate navigable list', async () => {
        const cards: BoardCard[] = Array.from({ length: 40 }, (_, index) => {
            const ref = { kind: 'workflow' as const, qualifiedId: { serverId: 'home', id: `w${index}` } };
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, availability: 'ready', title: `Workflow ${index}`,
                status: { state: 'idle', attentionType: null, bucket: 'idle', tone: 'neutral', word: 'Idle' }, body: { kind: 'none' } };
        });
        const remove = vi.fn();
        vi.useFakeTimers();
        const dispatch = vi.fn(async () => ({ status: 'applied' as const, boards: { v: 1 as const, boards: [] } }));
        const screen = await renderScreen(<BoardSettingsButton
            board={{ ...createWorkBoardV1({ id: 'board', name: 'Board' }), source: { picked: cards.map(card => card.ref) } }}
            homes={{ activeServerId: null, mountedServerIds: [], isHomeMounted: () => false }}
            pickedCards={cards} canvasAvailable dispatch={dispatch} onRemoveItem={remove}
            onDeleted={() => {}} open onOpenChange={() => {}} onAddByHand={() => {}}
        />, layout);
        expect(Boolean(screen.findHostByTestId('board-settings.name'))).toBe(true);
        const summary = screen.findHostByTestId('board-settings.picks:settings:option:picks');
        expect(Boolean(summary)).toBe(true);
        expect(screen.findHostByTestId(`board-settings.remove.${cards[0]!.key}`)).toBeNull();
        // Advance the real Deferred clock boundary before inspecting its switches.
        await flushHookEffects({ cycles: 1, runOnlyPendingTimers: true });
        vi.useRealTimers();
        const switches = screen.findAllByType(Switch);
        const snap = switches.find(node => node.props.testID === 'board-settings.snap');
        const pin = switches.find(node => node.props.testID === 'board-settings.pin');
        expect(snap).toBeDefined();
        expect(pin).toBeDefined();
        await act(async () => {
            snap!.props.onValueChange(false);
            pin!.props.onValueChange(true);
        });
        expect(dispatch).toHaveBeenCalledWith({ kind: 'update', boardId: 'board', patch: { snap: false } });
        expect(dispatch).toHaveBeenCalledWith({ kind: 'update', boardId: 'board', patch: { pinnedInSessions: true } });
        expect(screen.findHostByTestId('board-settings.delete')).not.toBeNull();
        await screen.pressByTestIdAsync('board-settings.picks:settings:option:picks');
        await screen.pressByTestIdAsync(`board-settings.remove.${cards[39]!.key}`);
        expect(remove).toHaveBeenCalledWith(cards[39]!.ref);
        await screen.pressByTestIdAsync('board-settings.picks:header:leading:back-chip');
        expect(screen.findHostByTestId('board-settings.delete')).not.toBeNull();
    });
});
