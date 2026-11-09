import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const { storage } = await import('@/sync/domains/state/storage');
const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { SessionContextSection } = await import('./SessionContextSection');
const { SessionMemorySection } = await import('../memory/SessionMemorySection');
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    await home?.dispose();
    home = undefined;
});

describe.each(['context', 'memory'] as const)('Work › %s stale choice through the real Action executor', section => {
    it.each(['apply', 'keep'] as const)('holds the draft and %s resolves it against the current Session', async decision => {
        const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
        const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init));
        const origin = `https://work-${section}-${decision}.test`;
        home = await createPlainArtifactHomeFixture(origin, {
            handleRequest: async (path, init) => sessionRequest(`${origin}${path}`, init),
        });
        await loadSyncSingletonForTests();
        const serverId = home.home.id;
        storage.setState({ isDataReady: true, settingsVersion: 1 });
        applyProjectAccountRowsFixture(storage);
        const notes = {
            id: 'notes-doc', title: 'Release notes', ownerAccountId: 'artifact-account', access: 'owner' as const,
            header: { v: 1, kind: 'prompt_doc.v2', title: 'Release notes' }, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true as const,
        };
        home.boundary.replaceStoredRow(createPlainArtifactHttpFixture(notes, 'artifact-account'));
        storage.getState().applyArtifacts([notes]);
        applyPromptLibraryCatalogSnapshot({ serverId, accountId: 'artifact-account' }, {
            catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1,
        }, true);
        const stack = [{ id: 'session.notes', ref: { kind: 'doc' as const, artifactId: 'notes-doc', serverId },
            enabled: true, placement: 'system_append' as const }];
        const current = createSessionFixture({ id: 'stale-choice', serverId, metadataVersion: 10,
            metadata: { path: '/worktree', host: 'localhost', work: { promptStack: stack, memoryEnabled: false } } });
        storage.setState({ sessions: { ...storage.getState().sessions, [current.id]: current } });
        const body = (session: typeof current) => <InjectedAuthProvider credentials={null}>{section === 'context'
            ? <SessionContextSection serverId={serverId} session={session} />
            : <SessionMemorySection serverId={serverId} session={session} />}</InjectedAuthProvider>;
        const screen = await renderScreen(body({ ...current, metadataVersion: 9 }));
        const control = section === 'context' ? 'session-work-context.entry.session.session.notes.enabled' : 'session-work-memory.enabled.switch';
        const prefix = `session-work-${section}`;
        await React.act(async () => { screen.findByTestId(control)?.props.onValueChange(section === 'memory'); });
        await vi.waitFor(() => expect(screen.findByTestId(`${prefix}.conflict`)).toBeTruthy());
        expect(sessionHttp.writes).toEqual([]);
        expect(screen.findByTestId(`${prefix}.refused`)).toBeNull();
        expect(screen.findByTestId(control)?.props.value).toBe(section === 'context');
        expect(screen.getTextContent()).toContain('sessionIntentConflict.changedNow');
        if (section === 'context') expect(screen.getTextContent()).toContain('Release notes');

        await screen.update(body(current));
        await screen.pressByTestIdAsync(`${prefix}.conflict.${decision}`);
        await vi.waitFor(() => expect(screen.findByTestId(`${prefix}.conflict`)).toBeNull());
        if (decision === 'apply') {
            await vi.waitFor(() => expect(sessionHttp.writes).toEqual([current.id]));
            expect(readSessionOwnerMetadataView(storage.getState().sessions[current.id]!)?.work).toMatchObject(section === 'context'
                ? { promptStack: [{ ...stack[0], enabled: false }] }
                : { memoryEnabled: true });
        } else {
            expect(sessionHttp.writes).toEqual([]);
            expect(readSessionOwnerMetadataView(storage.getState().sessions[current.id]!)?.work).toMatchObject({
                promptStack: stack, memoryEnabled: false,
            });
        }
        await screen.unmount();
    });
});
