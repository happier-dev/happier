/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import { createSessionListQuerySourceHarness, waitForSessionListQueryState, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from './sessionListRenderable';
import { useSessionListQueryHomeStates, useSessionListQuerySourceState, type SessionListQuerySourceState } from './useSessionListQuerySourceState';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: false, scope: 'all_accessible',
    attention: 'any', audiences: [], tagIds: [], includeAttention: true,
};

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { await boundary.dispose(); });

async function mount(element: React.ReactElement) {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(element); });
    return { async unmount() {
        await act(async () => root.unmount());
        container.remove();
        environment.IS_REACT_ACT_ENVIRONMENT = previous;
    } };
}

async function writeMetadata(serverId: string, sessionId: string, version: number) {
    const row = storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    if (!row) throw new Error('The Session row must be admitted before it is updated');
    await act(async () => storage.getState().applyServerScopedSessionListRowPatches(serverId, [{
        sessionId, patch: { metadataVersion: version, metadata: { ...row.metadata, path: row.metadata?.path ?? '', name: 'Name ' + version } },
    }]));
}

describe('session list query source: subscription locality', () => {
    it('does no index renders when a Session row write leaves every Home index unchanged', async () => {
        // The list pane subscriber redrew on every message and agent-state write on the Account.
        const serverId = boundary.serverIds[0]!;
        const homes = [{ serverId, query: QUERY }];
        let renders = 0;
        const state: { current: SessionListQuerySourceState | null } = { current: null };
        function Host() {
            state.current = useSessionListQuerySourceState({ enabled: true, homes });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settled = { renders, result: state.current };
            const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'unlisted-writer', serverId }));
            for (let seq = 1; seq <= 3; seq++) {
                await act(async () => storage.setState((current) => ({ sessionListRowsByServerId: {
                    ...current.sessionListRowsByServerId,
                    [serverId]: { ...current.sessionListRowsByServerId[serverId], [row.id]: { ...row, seq } },
                } })));
            }
            expect(renders - settled.renders).toBe(0);
            expect(state.current).toBe(settled.result);
        } finally { await screen.unmount(); }
    });
    it('does not re-render a disabled source (the home and summary paths) when session rows or Machines change', async () => {
        const serverId = boundary.serverIds[0]!;
        const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'idle-row', metadataVersion: 1 }));
        storage.getState().applyServerScopedSessionListRows(serverId, [row], { source: 'ordinary', mode: 'replace' });
        let machine = createMachineFixture({ id: 'disabled-query-machine', activeAt: Date.now(),
            daemonState: { contributionRegistryProjectionRevision: 1 } });
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        let renders = 0;
        function Host() {
            useSessionListQuerySourceState({ enabled: false, homes: [] });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            const settled = renders;
            await writeMetadata(serverId, row.id, 2);
            await writeMetadata(serverId, row.id, 3);
            for (let index = 0; index < 5; index++) {
                machine = { ...machine, seq: machine.seq + 1, daemonStateVersion: machine.daemonStateVersion + 1,
                    activeAt: Date.now(), updatedAt: Date.now() };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(renders).toBe(settled);
        } finally { await screen.unmount(); }
    });

    it('does not re-render a states-only consumer (personal membership) when a session row changes', async () => {
        const serverId = boundary.serverIds[0]!;
        const sessionId = boundary.accountId(serverId) + '-row';
        const homes = [{ serverId, query: QUERY }];
        let renders = 0;
        const state: { current: ReturnType<typeof useSessionListQueryHomeStates> | null } = { current: null };
        function Host() {
            state.current = useSessionListQueryHomeStates({ enabled: true, homes });
            renders += 1;
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settled = renders;
            const settledStates = state.current?.statesByServerId;
            expect(boundary.queryRequests.some(request => request.serverId === serverId)).toBe(true);
            await writeMetadata(serverId, sessionId, 2);
            await writeMetadata(serverId, sessionId, 3);
            expect(renders).toBe(settled);
            expect(state.current?.statesByServerId).toBe(settledStates);
        } finally { await screen.unmount(); }
    });

    it('keeps the index of an enabled source when only a row\'s metadata changed, and rebuilds it when the corpus changed', async () => {
        const serverId = boundary.serverIds[0]!;
        const sessionId = boundary.accountId(serverId) + '-row';
        const homes = [{ serverId, query: QUERY }];
        const state: { current: SessionListQuerySourceState | null } = { current: null };
        function Host() {
            state.current = useSessionListQuerySourceState({ enabled: true, homes });
            return null;
        }
        const screen = await mount(<Host />);
        try {
            await waitForSessionListQueryState(() => expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready'));
            const settledSource = state.current?.source;
            const settledByServerId = state.current?.byServerId;
            expect(Array.isArray(settledSource)).toBe(true);
            expect(settledSource?.length).toBeGreaterThan(0);
            await writeMetadata(serverId, sessionId, 2);
            expect(state.current?.source).toBe(settledSource);
            expect(state.current?.byServerId).toBe(settledByServerId);
            boundary.setRows(serverId, [sessionId, 'late-row']);
            await act(async () => { await state.current?.refresh(); });
            expect(state.current?.source).not.toBe(settledSource);
            expect(state.current?.statesByServerId[serverId]?.addresses.map(address => address.sessionId)).toEqual([sessionId, 'late-row']);
        } finally { await screen.unmount(); }
    });
});
