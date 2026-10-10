import * as React from 'react';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
import { makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionSystemRecordHttpFixture, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionBoardActionResultReference } from './SessionBoardActionResultReference';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = { v: 1, destination: 'transcript', title: 'Result', frame: 'frameless',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Child-owned result' } } },
} as const;

async function prepare(itemId = 'visual') {
    const record = SessionSystemRecordStoredSchema.parse({ id: 'visual-record',
        address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: itemId },
        content: { t: 'plain', v: item }, revision,
        createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
    });
    const fixture = createSessionSystemRecordHttpFixture({ sessionId: 'session-1', records: [record] });
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://inline-session-content.test', request: fixture.request });
    onTestFinished(async () => { standardCleanup(); await connection.dispose(); });
    const tool = makeToolCall({ name: 'session_board_item_upsert', state: 'completed',
        input: { itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item },
        result: { v: 1, serverId: connection.home.id, sessionId: 'session-1',
            result: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision },
            destination: null, itemDestination: 'transcript' },
    });
    return { fixture, tool, serverId: connection.home.id };
}

describe('Session-owned inline content', () => {
    it('reads and renders an acknowledged declarative item without a Board controller or feature', async () => {
        const { fixture, tool, serverId } = await prepare();
        const screen = await renderScreen(<SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="session-1" />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Child-owned result'));
        expect(fixture.recordReads).toEqual(['visual']);
    });

    it('does not request hidden-row content until the existing row visibility owner demands it', async () => {
        const { fixture, tool, serverId } = await prepare();
        const screen = await renderScreen(<SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="session-1" contentDemand={false} />);
        expect(fixture.recordReads).toEqual([]);
        expect(screen.getTextContent()).not.toContain('Child-owned result');
        await screen.update(<SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="session-1" contentDemand />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Child-owned result'));
        expect(fixture.recordReads).toEqual(['visual']);
    });

    it('resolves an inherited reference only to its independently readable child copy', async () => {
        const { fixture, tool, serverId } = await prepare('child-visual');
        const original = { serverId, sessionId: 'session-1' };
        const screen = await renderScreen(<SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="parent"
            visualContext={{ sessionId: 'session-1', originAddress: original, copies: [{ originServerId: serverId,
                originSessionId: 'session-1', originItemId: 'visual', status: 'copied', itemId: 'child-visual' }] }} />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Child-owned result'));
        expect(fixture.recordReads).toEqual(['child-visual']);
    });

    it('shows a stable not-copied state without falling back to a parent read', async () => {
        const { fixture, tool, serverId } = await prepare();
        const screen = await renderScreen(<SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="session-1"
            visualContext={{ sessionId: 'child', copies: [{ originServerId: serverId,
                originSessionId: 'session-1', originItemId: 'visual', status: 'not_copied' }] }} />);
        expect(screen.findByTestId('transcript-board-item-visual-not-copied')).not.toBeNull();
        expect(fixture.recordReads).toEqual([]);
    });
});
