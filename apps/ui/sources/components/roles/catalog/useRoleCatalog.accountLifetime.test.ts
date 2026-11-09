import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { invalidateRoleCatalog, useRoleCatalog } from './useRoleCatalog';

installDisconnectedServerSocketBoundary();

function promptLibraryRowsResponse() {
    return Response.json({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    })) });
}

afterEach(() => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    resetServerFeaturesClientForTests();
});

describe('role catalog Account lifetime', () => {
    it.each([false, true])('coalesces post-save invalidations during an old read and retires pending work: %s', async (retire) => {
        await loadSyncSingletonForTests();
        const bridge = await loadVitestModuleForNodeRequire(
            new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        onTestFinished(bridge.dispose);
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        const roleId = '11111111-1111-4111-8111-111111111111';
        const role: RoleArtifactV1 = { name: 'Builder', instructions: 'Before save', runsAs: { kind: 'session' },
            workspaceWrites: 'allow', secondOpinion: 'off', enabled: true };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
        await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: roleId,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'role.v1', title: role.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(role) }) }) });
        const staleRead = createDeferred<void>();
        let holdRead = false;
        let held = false;
        let lists = 0;
        let settingsVersion = 0;
        let settings: Record<string, unknown> = { rolesV1: { overrides: {} } };
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://role-mutation-flight.example.test', accountId: 'alice',
            request: async (url, init) => {
                const target = new URL(String(url));
                const path = target.pathname;
                if (path === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                    v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
                } } });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/entity-rows/prompt-library') return promptLibraryRowsResponse();
                if (path === '/v2/account/settings') {
                    if (init?.method === 'POST') {
                        const write = JSON.parse(String(init.body)) as { content: { t: 'plain'; v: Record<string, unknown> }; expectedVersion: number };
                        expect(write.expectedVersion).toBe(settingsVersion);
                        settings = write.content.v;
                        return Response.json({ success: true, version: ++settingsVersion });
                    }
                    return Response.json({ content: { t: 'plain', v: settings }, version: settingsVersion });
                }
                if (path === '/v1/artifacts') {
                    lists += 1;
                    const response = await artifacts.handle(`${path}${target.search}`, init);
                    if (holdRead && !held) {
                        held = true;
                        await staleRead.promise;
                    }
                    return response!;
                }
                return await artifacts.handle(`${path}${target.search}`, init) ?? new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        const catalog = await renderHook(() => useRoleCatalog());
        const entry = () => catalog.getCurrent().entries.find((item) => item.roleId === roleId)!;
        await vi.waitFor(() => expect(entry()?.role.instructions).toBe('Before save'));
        const initialLists = lists;
        holdRead = true;
        await act(async () => { catalog.getCurrent().refresh(); });
        await vi.waitFor(() => expect(held).toBe(true));
        // Another open and refresh share the same read; they must not demand a second one.
        const concurrent = await renderHook(() => useRoleCatalog());
        await act(async () => { concurrent.getCurrent().refresh(); });
        expect(lists).toBe(initialLists + 1);
        await act(async () => {
            expect(await roleActions.update(roleId, { ...role, instructions: 'Saved instructions' }, entry().revision!)).toMatchObject({ ok: true });
            invalidateRoleCatalog();
            invalidateRoleCatalog();
        });
        if (retire) await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        await act(async () => { staleRead.resolve(); });
        if (retire) {
            expect(catalog.getCurrent().entries).toEqual([]);
            expect(lists).toBe(initialLists + 1);
        } else {
            await vi.waitFor(() => expect(entry()?.role.instructions).toBe('Saved instructions'));
            expect(lists).toBe(initialLists + 2);
            expect(entry().revision).toEqual({ headerVersion: 2, bodyVersion: 2 });
            await act(async () => {
                expect(await roleActions.update(roleId, { ...role, instructions: 'Next edit' }, entry().revision!)).toMatchObject({ ok: true });
            });
            expect(artifacts.read(roleId)?.bodyVersion).toBe(3);
        }
    });

    it.each(['credential_retirement', 'account_switch', 'runtime_retirement'] as const)('drops retained roles on %s and reads again on reopening', async (transition) => {
        await loadSyncSingletonForTests();
        const bridge = await loadVitestModuleForNodeRequire(
            new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        onTestFinished(bridge.dispose);
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        let lists = 0;
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
        const reopenedList = createDeferred<void>();
        let holdList = false;
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://role-lifetime.example.test', accountId: 'alice',
            request: async (url, init) => {
                const target = new URL(String(url));
                const path = target.pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/entity-rows/prompt-library') return promptLibraryRowsResponse();
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/artifacts') {
                    lists += 1;
                    if (holdList) await reopenedList.promise;
                    return (await artifacts.handle(`${path}${target.search}`, init))!;
                }
                return new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        const catalog = await renderHook(() => useRoleCatalog());
        await vi.waitFor(() => expect(catalog.getCurrent().entries.length).toBeGreaterThan(0));
        const previousLists = lists;
        const otherHome = await renderHook(() => useRoleCatalog('another-home'));
        expect(otherHome.getCurrent()).toMatchObject({ entries: [], status: 'failed' });
        expect(lists).toBe(previousLists);
        await otherHome.unmount();
        await act(async () => {
            if (transition === 'credential_retirement') retireActiveServerAccountScopeLifetime();
            else if (transition === 'runtime_retirement') publishAppliedActiveServerRuntimeAvailability(false);
            else storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'bob' });
        });
        expect(catalog.getCurrent().entries).toEqual([]);
        if (transition === 'runtime_retirement') {
            expect(catalog.getCurrent().status).toBe('failed');
            holdList = true;
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
            expect(catalog.getCurrent().entries).toEqual([]);
            await act(async () => { reopenedList.resolve(); });
            await vi.waitFor(() => expect(catalog.getCurrent().entries.length).toBeGreaterThan(0));
            expect(lists).toBeGreaterThan(previousLists);
            return;
        }
        await catalog.unmount();
        holdList = true;
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        const reopened = await renderHook(() => useRoleCatalog());
        expect(reopened.getCurrent().entries).toEqual([]);
        await act(async () => { reopenedList.resolve(); });
        await vi.waitFor(() => expect(reopened.getCurrent().entries.length).toBeGreaterThan(0));
        expect(lists).toBeGreaterThan(previousLists);
    });
});
