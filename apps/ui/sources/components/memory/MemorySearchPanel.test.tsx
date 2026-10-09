import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MemoryDocumentSearchCoverageV1, MemorySearchResultHitV1 } from '@happier-dev/protocol/memory/memorySearch';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineAdministrationFixture } from '@/dev/testkit/fixtures/machineAdministrationFixture';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const homes = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { MemorySearchPanel } = await import('./MemorySearchPanel');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let administration: Awaited<ReturnType<typeof createMachineAdministrationFixture>>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
const baseline = storage.getState();
const transcript: MemorySearchResultHitV1 = {
    sessionId: 'past-session', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
    summary: 'Matching past conversation', score: 0.5,
};
const document: MemorySearchResultHitV1 = {
    type: 'artifact', ref: { kind: 'doc', serverId: 'server-a', artifactId: 'memory-doc' },
    revision: { headerVersion: 1, bodyVersion: 2 }, location: { type: 'topic', title: 'Archive' },
    factId: 'fact-1', summary: 'Matching archived fact', score: 0.8,
};
const status = {
    v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: true, activeIndexReady: true,
    embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
    embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
    tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
};

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await homes.reset();
    storage.setState(baseline, true);
    administration = await createMachineAdministrationFixture('memory.settings');
    const machine = storage.getState().machineListByServerId[administration.serverIds[0]!]![0]!;
    await homes.addHome({ name: 'Memory Home', serverUrl: 'https://prompt-administration-1.example.test',
        serverIdentityId: 'srv_prompt_administration_1', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-administration-1.example.test',
        accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine },
        settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { 'memory.settings': administration.targets[0]! } },
        profileScope: { serverId: administration.serverIds[0]!, accountId: 'account-a' } });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
    await administration.cleanup();
    await homes.reset();
    machineRpc.mockReset();
    webLocks.restore();
});

async function search(coverage: MemoryDocumentSearchCoverageV1 | null, hits: readonly MemorySearchResultHitV1[]) {
    machineRpc.mockImplementation(async (request: Readonly<{ method: string }>) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
        ? { ...status, ...(coverage ? { documentSearchSupported: true } : {}) }
        : { v: 1, ok: true, hits, ...(coverage ? { documents: coverage } : {}) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection!.credentials}>
        <MemorySearchPanel testID="search" serverId={administration.serverIds[0]!} />
    </InjectedAuthProvider>);
    await flushHookEffects();
    expect(screen.findByTestId('search.input')?.props.editable).toBe(true);
    await act(async () => screen.findByTestId('search.input')!.props.onChangeText('fact'));
    await act(async () => {
        await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true));
    });
    await flushHookEffects();
    return screen;
}

describe('MemorySearchPanel corpus coverage', () => {
    it('keeps older-daemon Session hits usable while identifying unavailable document search', async () => {
        const screen = await search(null, [transcript]);
        expect(screen.findByTestId('search.session.0')).toBeTruthy();
        expect(screen.findByTestId('search.documentsCoverage')).toBeTruthy();
        expect(screen.findByTestId('search.empty')).toBeNull();
    });
    it('shows pending document coverage alongside mixed usable hits', async () => {
        const screen = await search({ state: 'pending' }, [document, transcript]);
        expect(screen.findByTestId('search.remembered.0')).toBeTruthy();
        expect(screen.findByTestId('search.session.0')).toBeTruthy();
        expect(screen.findByTestId('search.documentsCoverage-spinner')).toBeTruthy();
    });
    it.each(['pending', 'unavailable'] as const)('does not claim ready-empty while document coverage is %s', async (state) => {
        const screen = await search({ state }, []);
        expect(screen.findByTestId('search.documentsCoverage')).toBeTruthy();
        expect(screen.findByTestId('search.empty')).toBeNull();
    });
    it('shows ready-empty only when the document corpus is ready', async () => {
        const screen = await search({ state: 'ready' }, []);
        expect(screen.findByTestId('search.documentsCoverage')).toBeNull();
        expect(screen.findByTestId('search.empty')).toBeTruthy();
    });
});
