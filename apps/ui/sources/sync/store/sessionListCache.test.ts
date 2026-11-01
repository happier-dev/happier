import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    setActiveServerId,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { clearServerSessionListCache, setActiveServerSessionListCache, setServerSessionListCache } from './sessionListCache';

beforeEach(() => {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `session-list-cache-${Math.random()}`);
});

afterEach(() => vi.unstubAllEnvs());

function snapshot(serverId: string, title: string): SessionListViewItem[] {
    return [{ type: 'header', title, serverId }];
}

describe('sessionListCache helpers', () => {
    it('sets cache for explicit server id', () => {
        const current = { existing: null };
        const next = setServerSessionListCache(current, 'server-b', []);
        expect(next).toEqual({ existing: null, 'server-b': [] });
    });

    it('sets cache for active server id', () => {
        const active = upsertServerProfile({ serverUrl: 'https://active.example.test' });
        setActiveServerId(active.id, { scope: 'device' });
        const next = setActiveServerSessionListCache({ existing: null }, []);
        expect(next).toEqual({ existing: null, [active.id]: [] });
    });

    it('keeps a later refresh from the original publisher visible after Home identity promotion', () => {
        const home = upsertServerProfile({ serverUrl: 'https://remote.example.test' });
        const unrelated = snapshot('unrelated', 'Other Home');
        let cache = setServerSessionListCache({ unrelated }, home.id, snapshot(home.id, 'Before archive'));
        setServerProfileIdentityForUrl(home.serverUrl, 'srv_remote_identity');
        cache = setServerSessionListCache(cache, 'srv_remote_identity', snapshot('srv_remote_identity', 'Archived'));
        // A running concurrent publisher captured the profile id before /features discovered the identity.
        cache = setServerSessionListCache(cache, home.id, snapshot(home.id, 'Fresh periodic snapshot'));

        const visible = resolveSessionListSourceData({
            enabled: true,
            activeServerId: 'unrelated',
            activeData: null,
            byServerId: cache,
            selectedServerIds: ['srv_remote_identity'],
        });
        expect(visible).toEqual(snapshot('srv_remote_identity', 'Fresh periodic snapshot'));
        expect(Object.keys(cache).sort()).toEqual(['srv_remote_identity', 'unrelated']);
        expect(cache.unrelated).toBe(unrelated);
    });

    it('retires all equivalent alias buckets while preserving unrelated snapshots and no-op publications', () => {
        const home = upsertServerProfile({ serverUrl: 'https://aliases.example.test' });
        setServerProfileIdentityForUrl(home.serverUrl, 'srv_previous_identity');
        setServerProfileIdentityForUrl(home.serverUrl, 'srv_current_identity');
        const rows = snapshot('srv_current_identity', 'Current');
        const other = snapshot('other', 'Other');
        const current = {
            [home.id]: snapshot(home.id, 'Old profile snapshot'),
            srv_previous_identity: snapshot('srv_previous_identity', 'Old identity snapshot'),
            other,
        };
        const next = setServerSessionListCache(current, home.id, rows);
        expect(Object.keys(next).sort()).toEqual(['other', 'srv_current_identity']);
        expect(next.srv_current_identity).toBe(rows);
        expect(next.other).toBe(other);
        expect(setServerSessionListCache(next, home.id, rows)).toBe(next);
    });

    it('clears equivalent aliases together and preserves signed-out null snapshots on publication', () => {
        const home = upsertServerProfile({ serverUrl: 'https://clear.example.test' });
        setServerProfileIdentityForUrl(home.serverUrl, 'srv_clear_identity');
        const other = snapshot('other', 'Other');
        const warm = { [home.id]: snapshot(home.id, 'Warm'), srv_clear_identity: [], other };
        expect(clearServerSessionListCache(warm, home.id)).toEqual({ other });
        const signedOut = setServerSessionListCache(warm, home.id, null);
        expect(signedOut).toEqual({ srv_clear_identity: null, other });
        expect(setServerSessionListCache(signedOut, home.id, null)).toBe(signedOut);
        expect(clearServerSessionListCache({ other }, home.id).other).toBe(other);
    });

    it('binds workspace hints to the published Home while retaining stable grouping keys', () => {
        const home = upsertServerProfile({ serverUrl: 'https://workspace.example.test' });
        const rows: SessionListViewItem[] = [{
            type: 'header', title: 'Workspace', serverId: home.id,
            groupKey: `server:${home.id}:project:workspace`,
            workspaceScopeHint: { serverId: home.id, machineId: 'machine', rootPath: '/workspace' },
        }];
        setServerProfileIdentityForUrl(home.serverUrl, 'srv_workspace_identity');
        const next = setServerSessionListCache({}, home.id, rows);
        expect(next.srv_workspace_identity?.[0]).toMatchObject({
            serverId: 'srv_workspace_identity', groupKey: `server:${home.id}:project:workspace`,
            workspaceScopeHint: { serverId: 'srv_workspace_identity', machineId: 'machine', rootPath: '/workspace' },
        });
        expect(rows[0].serverId).toBe(home.id);
        expect(setServerSessionListCache(next, home.id, [...rows])).toBe(next);
    });

    it('preserves unchanged legacy row references when another selected Home refreshes', () => {
        const home = upsertServerProfile({ serverUrl: 'https://warm.example.test' });
        const warm = snapshot(home.id, 'Warm snapshot');
        setServerProfileIdentityForUrl(home.serverUrl, 'srv_warm_identity');
        const resolve = (other: SessionListViewItem[]) => resolveSessionListSourceData({
            enabled: true,
            activeServerId: 'other',
            activeData: other,
            byServerId: { [home.id]: warm, other },
            selectedServerIds: ['srv_warm_identity', 'other'],
        });
        const first = resolve(snapshot('other', 'First'));
        const refreshed = resolve(snapshot('other', 'Second'));
        expect(first?.[0]).toMatchObject({ serverId: 'srv_warm_identity', title: 'Warm snapshot' });
        expect(refreshed?.[0]).toBe(first?.[0]);
        expect(warm[0].serverId).toBe(home.id);
    });
});
