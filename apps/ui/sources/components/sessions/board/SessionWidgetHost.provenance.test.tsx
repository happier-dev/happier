import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSurfaceNoteDocumentV1 } from '@happier-dev/protocol/sessions/board';
import { UsersSearchResponseSchema } from '@happier-dev/protocol/social/friends';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { SessionWidgetHost } from './SessionWidgetHost';

afterEach(standardCleanup);

function snapshotCard(serverId: string, postedByAccountId = 'poster') {
    return <SessionWidgetHost
        serverId={serverId} sessionId="shared-session"
        item={{ itemId: 'frozen', revision: 'one', state: { kind: 'ready', item: {
            v: 1, title: 'Directory count', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Frozen 2') },
            snapshot: { asOf: '2026-10-22T09:10:25.360Z', provenance: [], postedByAccountId },
        } } }}
        host="details" density="full" canEdit={false}
        width="medium" heightBounds={{ min: 96, max: 520 }}
        testID="snapshot"
    />;
}

describe('SessionWidgetHost snapshot author', () => {
    it('hydrates an unknown other Account and replaces the fallback with its name', async () => {
        let releaseProfile: ((response: Response) => void) | undefined;
        const home = await serveAccountHomes({
            homes: [{ key: 'shared', serverUrl: 'https://snapshot-author.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles'
                ? new Promise<Response>(resolve => { releaseProfile = resolve; }) : undefined,
        });
        try {
            const scope = { serverId: home.homes.shared!.id, accountId: 'viewer' };
            getStorage().setState({ profileScope: scope, users: {} });
            const screen = await renderScreen(snapshotCard(scope.serverId));
            expect(JSON.stringify(screen.tree.toJSON())).toContain('Snapshot');
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Snapshot by you');
            await vi.waitFor(() => expect(releaseProfile).toBeDefined());
            await React.act(async () => { releaseProfile!(Response.json(UsersSearchResponseSchema.parse({ users: [{
                id: 'poster', firstName: 'Morgan', lastName: 'River', username: 'morgan',
                avatar: null, bio: null, status: 'none', publicKey: null,
            }] }))); });
            await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('Snapshot by Morgan River'));
            expect(home.requests.find(request => request.path === '/v1/user/profiles')?.accountId).toBe('viewer');
        } finally {
            releaseProfile?.(Response.json({ error: 'not_found' }, { status: 404 }));
            standardCleanup();
            await home.dispose();
        }
    });

    it.each([404, 403])('keeps the snapshot readable when its author profile returns %s', async status => {
        const home = await serveAccountHomes({
            homes: [{ key: 'shared', serverUrl: 'https://snapshot-author-unreadable.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles'
                ? Response.json({ error: 'unavailable' }, { status }) : undefined,
        });
        try {
            const scope = { serverId: home.homes.shared!.id, accountId: 'viewer' };
            getStorage().setState({ profileScope: scope, users: {} });
            const screen = await renderScreen(snapshotCard(scope.serverId));
            await vi.waitFor(() => expect(home.requests.some(request => request.path === '/v1/user/profiles')).toBe(true));
            expect(JSON.stringify(screen.tree.toJSON())).toContain('Frozen 2');
            expect(JSON.stringify(screen.tree.toJSON())).toContain('Snapshot');
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Snapshot by');
        } finally {
            standardCleanup();
            await home.dispose();
        }
    });
});
