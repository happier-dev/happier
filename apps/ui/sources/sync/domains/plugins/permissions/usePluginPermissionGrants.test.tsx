import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDeferred, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginPermissionGrant, PluginPermissionPendingGrantRequest } from './types';

installSessionFilesViewBoundaries();
beforeAll(prepareSessionFilesViewTestkit);
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });
const targetScope = { kind: 'project', projectId: 'exact-checkout' } as const;
const capability = 'reviews.comments.write.direct' as const;
const pending: PluginPermissionPendingGrantRequest = { v: 1, id: 'request', accountId: 'alice', pluginId: 'review-coderabbit', capability,
    targetScope, requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 's1' }, authoritySource: { kind: 'bundled' },
    reason: 'Requested', status: 'pending', createdAt: 1, updatedAt: 1, subject: { kind: 'general' } };
const grant: PluginPermissionGrant = { v: 1, id: 'grant', accountId: 'alice', pluginId: 'review-coderabbit', capability, targetScope,
    status: 'active', requestId: 'request', authoritySource: { kind: 'bundled' }, grantedByUserId: 'alice', grantedAt: 2,
    createdAt: 2, updatedAt: 2, subject: { kind: 'general' } };

async function mount(request: typeof import('@/sync/http/client').serverFetch, enabled = true) {
    fixture = await createSessionFilesViewFixture();
    const { createPluginPermissionGrantHttpActionExecutor } = await import('./api');
    const { createPluginPermissionGrantActions } = await import('./actions');
    const { usePluginPermissionGrants } = await import('./usePluginPermissionGrants');
    const actions = createPluginPermissionGrantActions({ execute: createPluginPermissionGrantHttpActionExecutor({ request }) });
    let current: ReturnType<typeof usePluginPermissionGrants> | null = null;
    function Host(props: { scope: ServerAccountScope; enabled?: boolean }) {
        current = usePluginPermissionGrants({ actions, scope: props.scope, enabled: props.enabled ?? enabled,
            listInput: { capability, targetScope } });
        return null;
    }
    const scope = { serverId: fixture.home.id, accountId: 'alice' };
    const screen = await fixture.render(<Host scope={scope} />);
    return { screen, Host, scope, current: () => { if (!current) throw new Error('Not mounted'); return current; } };
}

describe('permission grants through real schemas/actions/store beneath Account HTTP', () => {
    it('publishes admitted approval, revocation and dismissal through the same owner', async () => {
        const owner = await mount(async path => {
            if (String(path).endsWith('/grant')) return Response.json({ grant,
                pendingRequest: { ...pending, status: 'granted', grantId: grant.id, decidedAt: 2 } });
            if (String(path).endsWith('/revoke')) return Response.json({ grant: { ...grant, status: 'revoked', revokedAt: 3 } });
            if (String(path).endsWith('/dismissRequest')) return Response.json({
                pendingRequest: { ...pending, status: 'dismissed', decidedAt: 4 } });
            return Response.json({ grants: [], pendingRequests: [pending] });
        });
        await act(async () => { await owner.current().grant({ requestId: pending.id }); });
        expect(owner.current().hasGrant({ capability, targetScope })).toBe(true);
        expect(owner.current().pendingRequests).toEqual([]);
        await act(async () => { await owner.current().revoke({ grantId: grant.id }); });
        expect(owner.current().hasGrant({ capability, targetScope })).toBe(false);
        await act(async () => { owner.current().upsertPendingRequest(pending); await owner.current().dismissRequest({ requestId: pending.id }); });
        expect(owner.current().pendingRequests).toEqual([]);
    });
    it('preserves admitted rows during an offline refresh and replaces them on recovery', async () => {
        let reads = 0;
        const owner = await mount(async () => {
            if (++reads === 2) throw new Error('offline');
            return Response.json({ grants: reads === 1 ? [grant] : [], pendingRequests: reads === 1 ? [pending] : [] });
        });
        expect(owner.current().hasGrant({ capability, targetScope })).toBe(true);
        await act(async () => { await owner.current().refresh(); });
        expect(owner.current().state.status).toBe('error');
        expect(owner.current().hasGrant({ capability, targetScope })).toBe(true);
        await act(async () => { await owner.current().refresh(); });
        expect(owner.current().state.status).toBe('ready');
        expect(owner.current().pendingRequests).toEqual([]);
        expect(owner.current().hasGrant({ capability, targetScope })).toBe(false);
    });

    it('clears grants before another Home/Account can render and rejects retained callbacks before dispatch', async () => {
        const requests: string[] = [];
        const owner = await mount(async path => { requests.push(String(path)); return Response.json({ grants: [grant], pendingRequests: [pending] }); });
        expect(owner.current().hasGrant({ capability, targetScope })).toBe(true);
        const old = owner.current();
        for (const scope of [{ ...owner.scope, accountId: 'bob' }, { ...owner.scope, serverId: 'another-home' }]) {
            await owner.screen.update(fixture.wrap(<owner.Host scope={scope} />));
            expect(owner.current().state.grantIds).toEqual([]);
            expect(owner.current().pendingRequests).toEqual([]);
            await act(async () => { await old.grant({ requestId: 'request' }); await old.refresh(); });
            expect(requests).toEqual(['/v1/plugins/permissions/grants/list']);
        }
    });

    it('ignores a held mutation after retirement and keeps disabled owners inert', async () => {
        const response = createDeferred<Response>();
        const requests: string[] = [];
        const owner = await mount(async path => {
            requests.push(String(path));
            return String(path).endsWith('/grant') ? response.promise : Response.json({ grants: [], pendingRequests: [pending] });
        });
        let mutation: Promise<void> | undefined;
        await act(async () => { mutation = owner.current().grant({ requestId: 'request' }); });
        await owner.screen.update(fixture.wrap(<owner.Host scope={owner.scope} enabled={false} />));
        response.resolve(Response.json({ grant, pendingRequest: { ...pending, status: 'granted', grantId: 'grant', decidedAt: 2 } }));
        await act(async () => { await mutation; await owner.current().revoke({ grantId: 'grant' }); await owner.current().dismissRequest({ requestId: 'request' }); });
        await flushHookEffects();
        expect(owner.current().state.grantIds).toEqual([]);
        expect(owner.current().pendingRequests).toEqual([]);
        expect(requests).toEqual(['/v1/plugins/permissions/grants/list', '/v1/plugins/permissions/grants/grant']);
    });
});
