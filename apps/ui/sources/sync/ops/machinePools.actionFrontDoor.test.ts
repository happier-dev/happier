import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, type MachinePoolViewV1 } from '@happier-dev/protocol';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import type { ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage, storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import { renderScreen } from '@/dev/testkit';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import {
    createMachinePool,
    deleteMachinePool,
    MachinePoolActionApprovalPendingError,
    MachinePoolActionRefusedError,
    refreshMachinePools,
} from './machinePools';

installApprovalCommonModuleMocks({ storage: (importOriginal) => importOriginal() });

const initialStorageState = getStorage().getState();
const initialSyncCredentials = sync.getCredentials();
const boundary = { serverId: '', requests: [] as string[] };
const features = {
    features: { machines: { enabled: true, pools: { enabled: true } } },
    capabilities: {
        accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
        },
    },
};

const created = {
    pool: {
        id: '00000000-0000-4000-8000-000000000001', name: 'Development',
        description: null, revision: 0, createdAt: 1, updatedAt: 1, members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
} satisfies MachinePoolViewV1;

function setActionsSettings(actions: Record<string, unknown>): void {
    const current = storage.getState().settings ?? {};
    storage.setState({ settings: { ...current, actionsSettingsV1: { v: 1, actions } } as never });
}

describe('machine pool Action front door', () => {
    beforeEach(async () => {
        retireActiveServerAccountScopeLifetime();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({ serverUrl: 'https://pool-front-door.test', name: 'Home' })).id;
        boundary.requests.length = 0;
        getStorage().getState().activateProfileScope({ serverId: boundary.serverId, accountId: 'alice' });
        getStorage().setState({ settingsScope: { serverId: boundary.serverId, accountId: 'alice' } });
        getStorage().setState({ machinePoolListByServerId: {}, machinePoolListStatusByServerId: {} });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: `e30.${btoa(JSON.stringify({ sub: 'alice' }))}.signature` });
        // Seed the authenticated singleton fixture without starting unrelated background sync.
        // All approval, artifact encoding, HTTP and store behavior remains real.
        Reflect.set(sync, 'credentials', { token: `e30.${btoa(JSON.stringify({ sub: 'alice' }))}.signature` });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        setRuntimeFetch(async (url, init) => {
            const value = String(url);
            const pathname = new URL(value).pathname;
            if (pathname === '/v1/auth/ping' || pathname === '/health') return Response.json({ ok: true });
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v1/artifacts' && init?.method === 'POST') {
                // This fixture is the HTTP server boundary for the actual artifact request.
                const request = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                return Response.json({ ...request, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
            boundary.requests.push(pathname);
            if (pathname === '/v1/machines/pools/list') return Response.json({ pools: [created] });
            if (pathname === '/v1/machines/pools/create') return Response.json(created);
            throw new Error(`Unexpected Machine Pool request: ${pathname}`);
        });
    });

    afterEach(() => {
        retireActiveServerAccountScopeLifetime();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        Reflect.set(sync, 'credentials', initialSyncCredentials);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('carries an enabled Pool intent through the shared executor to the canonical Home route', async () => {
        await expect(createMachinePool(boundary.serverId, { name: 'Development', description: null, members: [] }))
            .resolves.toMatchObject({ pool: { id: created.pool.id } });

        expect(boundary.requests).toEqual(['/v1/machines/pools/create']);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toEqual([created]);
    });

    it('refuses a Pool intent the shared Action settings disable, without reaching the Home', async () => {
        setActionsSettings({ 'machines.pools.create': { enabled: false } });

        await expect(createMachinePool(boundary.serverId, { name: 'Development', description: null, members: [] }))
            .rejects.toBeInstanceOf(MachinePoolActionRefusedError);

        expect(boundary.requests).toEqual([]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toBeUndefined();
    });

    it('keeps the projection refresh on the same front door', async () => {
        await expect(refreshMachinePools(boundary.serverId)).resolves.toEqual([created]);

        expect(boundary.requests).toEqual(['/v1/machines/pools/list']);
    });

    // A user who asks this surface to confirm Pool changes gets the shared executor's deferred
    // approval artifact instead of a Pool. Publishing that envelope would show a Pool the Home
    // never created, so the intent must surface as pending and leave the projection alone.
    it('reports a deferred approval for Create instead of publishing an uncreated Pool', async () => {
        setActionsSettings({ 'machines.pools.create': { approvalRequiredSurfaces: ['ui'] } });

        await expect(createMachinePool(boundary.serverId, { name: 'Development', description: null, members: [] }))
            .rejects.toBeInstanceOf(MachinePoolActionApprovalPendingError);

        expect(Object.values(getStorage().getState().artifacts)).toEqual([
            expect.objectContaining({ header: expect.objectContaining({ kind: 'approval_request.v1', actionId: 'machines.pools.create' }) }),
        ]);
        expect(boundary.requests).toEqual([]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toBeUndefined();
    });

    it('keeps a Pool listed when Delete only created a deferred approval', async () => {
        getStorage().getState().beginMachinePoolAccountScope(boundary.serverId, 'alice');
        getStorage().getState().replaceMachinePools([created], {
            sourceServerId: boundary.serverId,
            sourceAccountId: 'alice',
        });
        setActionsSettings({ 'machines.pools.delete': { approvalRequiredSurfaces: ['ui'] } });

        await expect(deleteMachinePool(boundary.serverId, { poolId: created.pool.id, expectedRevision: created.pool.revision }))
            .rejects.toBeInstanceOf(MachinePoolActionApprovalPendingError);

        expect(boundary.requests).toEqual([]);
        expect(Object.values(getStorage().getState().artifacts)).toEqual([
            expect.objectContaining({ header: expect.objectContaining({ kind: 'approval_request.v1', actionId: 'machines.pools.delete' }) }),
        ]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toEqual([created]);
    });
    it.each(['create', 'delete'] as const)('replays deferred %s on Home B while Home A remains focused', async (operation) => {
        const homeA = boundary.serverId;
        const homeB = (await upsertAndActivateServer({ serverUrl: 'https://pool-background.test', name: 'Background' })).id;
        // Re-activate Home A before exercising the deferred replay: the test requires
        // Home A to remain the focused Home while the approval replays against Home B.
        await upsertAndActivateServer({ serverUrl: 'https://pool-front-door.test', name: 'Home' });
        const token = (accountId: string) => `e30.${btoa(JSON.stringify({ sub: accountId }))}.signature`;
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (url) => ({
            token: token(url === 'https://pool-background.test' ? 'bob' : 'alice'),
        }));
        getStorage().setState({ settingsScope: { serverId: homeA, accountId: 'alice' } });
        setActionsSettings({ [`machines.pools.${operation}`]: { enabled: false } });
        const artifacts = new Map<string, ArtifactCreateRequest & { headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number }>();
        const effects: string[] = [];
        const requests: Array<{ host: string; authorization: string | null }> = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            const pathname = target.pathname;
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/auth/ping' || pathname === '/health') return Response.json({ ok: true });
            requests.push({ host: target.host, authorization: new Headers(init?.headers).get('authorization') });
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { [`machines.pools.${operation}`]: { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (pathname === '/v1/artifacts' && init?.method === 'POST') {
                const request = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                const artifact = { ...request, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                artifacts.set(request.id, artifact);
                return Response.json(artifact);
            }
            if (pathname.startsWith('/v1/artifacts/')) {
                const artifact = artifacts.get(pathname.split('/').at(-1)!);
                if (!artifact) return Response.json({}, { status: 404 });
                if (init?.method === 'POST') {
                    const update = JSON.parse(String(init.body));
                    if (update.header !== undefined) { artifact.header = update.header; artifact.headerVersion++; }
                    if (update.body !== undefined) { artifact.body = update.body; artifact.bodyVersion++; }
                    return Response.json({ success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
                }
                return Response.json(artifact);
            }
            if (pathname === `/v1/machines/pools/${operation}`) {
                effects.push(pathname);
                return Response.json(operation === 'create' ? created : { poolId: created.pool.id, deleted: true });
            }
            return Response.json({}, { status: 404 });
        });
        await getServerFeaturesSnapshot({ serverId: homeB, force: true });
        const pending = await (operation === 'create'
            ? createMachinePool(homeB, { name: 'Development', description: null, members: [] })
            : deleteMachinePool(homeB, { poolId: created.pool.id, expectedRevision: 0 }))
            .catch((error: unknown) => error);
        expect(pending).toBeInstanceOf(MachinePoolActionApprovalPendingError);
        if (!(pending instanceof MachinePoolActionApprovalPendingError)) return;
        expect(effects).toEqual([]);
        expect(getStorage().getState().artifacts).toEqual({});
        const executor = createDefaultActionExecutor();
        const screen = await renderScreen(React.createElement(ApprovalDetailScreen, {
            artifactId: pending.artifactId, serverId: homeB,
        }));
        await vi.waitFor(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
        await act(async () => { await screen.findByTestId('approvals.approve')!.props.onPress(); });
        await vi.waitFor(() => expect(effects).toEqual([`/v1/machines/pools/${operation}`]));
        await screen.unmount();
        await executor.execute('approval.request.decide', {
            artifactId: pending.artifactId, decision: 'approve',
        }, { serverId: homeB, surface: 'ui' });
        expect(effects).toEqual([`/v1/machines/pools/${operation}`]);
        const stored = artifacts.get(pending.artifactId)!;
        const body = decodePlainArtifactStoredContent(stored.body!) as { body: string };
        expect(JSON.parse(body.body)).toMatchObject({
            status: 'executed',
            actionId: `machines.pools.${operation}`,
            executionOriginV1: { serverId: homeB, accountId: 'bob' },
        });
        expect(requests.every((request) => request.host === 'pool-background.test' && request.authorization === `Bearer ${token('bob')}`)).toBe(true);
        expect(getStorage().getState().artifacts).toEqual({});
    });

});
