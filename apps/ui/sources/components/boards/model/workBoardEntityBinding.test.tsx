import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, buildWorkBoardArtifactHeaderV1,
    buildWorkBoardItemKeyV1, createWorkBoardV1, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { useWorkBoardEntityBinding } from './workBoardEntityBinding';
import { useWorkBoardSaveState } from './useWorkBoards';
import { projectBoardMembership } from './boardMembership';

// HTTP, device credential storage, native theme and applied connection are system boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/runtime/orchestration/connectionManager', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => getActiveServerSnapshot(), isAppliedActiveServerRuntimeAvailable: () => true,
}));
const previousState = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(previousState); runtimeFetch.mockReset(); vi.restoreAllMocks(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('mounted WorkBoard Action settlement', () => {
    it.each(['unknown', 'refused'] as const)('preserves %s through the real queue and Action executor', async disposition => {
        const home = await upsertAndActivateServer({ serverUrl: `https://board-settlement-${disposition}.test` });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'board-account' })), 'base64url')}.signature`;
        const credentials = { token };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        storage.setState({ profileScope: { serverId: home.id, accountId: 'board-account' }, settingsScope: { serverId: home.id, accountId: 'board-account' }, isDataReady: true });
        expect((await import('@/sync/runtime/orchestration/connectionManager')).getAppliedActiveServerSnapshot().serverId).toBe(home.id);
        expect((await import('@/sync/domains/state/storageStateReaderBridge')).readRegisteredStorageState()?.profileScope).toEqual(storage.getState().profileScope);
        expect((await import('@/sync/domains/scope/activeServerAccountScope')).getActiveServerAccountScope()).toEqual({ serverId: home.id, accountId: 'board-account' });
        const ref = { kind: 'machine', qualifiedId: { serverId: home.id, id: 'machine-a' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const board = { ...createWorkBoardV1({ id: 'board-a', name: 'Board' }), source: { picked: [ref] }, positionsByItemRef: { [key]: { x: 24, y: 24 } } };
        const row = { id: board.id, ownerAccountId: 'board-account', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)), body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: { v: 1,
                minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1' } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts') return json([row]);
            if (path === `/v1/artifacts/${board.id}` && init?.method === 'POST') {
                if (disposition === 'unknown') throw new Error('Connection lost after dispatch');
                return json({ error: 'not_found' }, 404);
            }
            if (path === `/v1/artifacts/${board.id}`) return disposition === 'refused' ? json({ error: 'not_found' }, 404) : json(row);
            throw new Error(`Unexpected route ${path}`);
        });
        const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
        const hook = await renderHook(() => ({ binding: useWorkBoardEntityBinding({ board, membership: projectBoardMembership(board, {
            isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }), save: useWorkBoardSaveState() }), { wrapper });
        const binding = hook.getCurrent().binding;
        expect(binding?.isCurrent()).toBe(true);
        if (!binding) throw new Error('Expected mounted Board binding');
        let outcome;
        await act(async () => { outcome = await binding.execute({ actionId: 'boards.apply', input: { intent: { kind: 'set_positions', boardId: board.id,
            positionsByItemRef: { [key]: { x: 48, y: 24 } } } }, preview: { verb: 'Move', target: 'Board' } }); });
        expect(outcome).toMatchObject({ status: disposition });
        expect(hook.getCurrent().save.failure).not.toBeNull();
    });
});
