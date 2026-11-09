/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionShellCommonModuleMocks } from '../sessionShellTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'span', Octicons: 'span' }));
vi.mock('expo-image', () => ({ Image: 'img' }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installSessionShellCommonModuleMocks({
    reactNative: async () => await vi.importActual('react-native-web'),
});

const { SessionPaneHeader } = await import('./SessionPaneHeader');
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { serveActionHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
const syncRuntime = await import('@/sync/sync');

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let releaseHeldWrite: (() => void) | undefined;

const byTestId = (testID: string) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const input = () => byTestId('session-header-title-input') as HTMLInputElement | null;
const trigger = () => byTestId('session-header-title');

async function beginEditing() {
    const title = trigger();
    if (!title) throw new Error('missing title trigger');
    await act(async () => { title.focus(); title.click(); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
}

describe('SessionPaneHeader inline title (DOM keyboard)', () => {
    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root.render(<SessionPaneHeader title="Fix settings modal remount" rename={{ sessionId: 'session-a', serverId: null }} />);
        });
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        releaseHeldWrite?.();
        releaseHeldWrite = undefined;
        await home?.dispose();
        home = undefined;
        storage.setState(storage.getInitialState(), true);
    });

    it('returns keyboard focus to the title after Escape, Cancel and an unchanged save', async () => {
        await beginEditing();
        await act(async () => {
            input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(input()).toBeNull());
        expect(document.activeElement).toBe(trigger());

        await beginEditing();
        const cancel = byTestId('session-header-title-cancel');
        if (!cancel) throw new Error('missing cancel');
        await act(async () => { cancel.focus(); cancel.click(); });
        await vi.waitFor(() => expect(input()).toBeNull());
        expect(document.activeElement).toBe(trigger());

        await beginEditing();
        await act(async () => {
            input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(input()).toBeNull());
        expect(document.activeElement).toBe(trigger());
    });

    it('retains the draft until the Home acknowledges a changed title, then returns focus to the title', async () => {
        // The Home's persisted seed stays independent of the client's changing projection.
        const persistedSessions: ReturnType<typeof storage.getState>['sessions'] = {};
        const boundary = createSessionMetadataHttpBoundary(() => persistedSessions);
        const writeAcknowledgement = new Promise<void>(resolve => { releaseHeldWrite = resolve; });
        let writeIssued = false;
        let holdRenameWrite = false;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://title-focus.test', accountId: 'account-a', currentAccount: true }],
            route: async request => {
                if (holdRenameWrite && request.method === 'PATCH' && request.path === '/v2/sessions/session-a') {
                    writeIssued = true;
                    await writeAcknowledgement;
                }
                return boundary.handle(request.url, { method: request.method, body: JSON.stringify(request.body) })
                    ?? (request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined);
            } });
        const server = home.homes.a!;
        const session = createSessionFixture({ id: 'session-a', serverId: server.id, encryptionMode: 'plain',
            metadata: { path: '/repo', host: 'test', name: 'Fix settings modal remount' } });
        persistedSessions[session.id] = structuredClone(session);
        await act(async () => {
            await syncRuntime.sync.refreshSessions({ awaitSessionListHydration: true });
            root.render(<SessionPaneHeader title="Fix settings modal remount" rename={{ sessionId: session.id, serverId: server.id }} />);
        });
        // Hydration may migrate the retained tuple before the person's rename.
        boundary.writes.splice(0);
        holdRenameWrite = true;
        await beginEditing();
        await act(async () => {
            const field = input()!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Renamed session');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const save = byTestId('session-header-title-save');
        if (!save) throw new Error('missing save');
        await act(async () => { save.focus(); save.click(); });
        await vi.waitFor(() => expect(writeIssued).toBe(true));
        expect(input()?.value).toBe('Renamed session');
        expect(boundary.writes).toEqual([]);
        await act(async () => { releaseHeldWrite!(); });
        await vi.waitFor(() => expect(input(), byTestId('session-header-title-reason')?.textContent ?? undefined).toBeNull());
        expect(boundary.writes).toEqual([session.id]);
        expect(document.activeElement).toBe(trigger());
    });
});
