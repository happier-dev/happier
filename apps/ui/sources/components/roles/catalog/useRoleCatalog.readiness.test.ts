import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred, renderHook } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { storage } from '@/sync/domains/state/storageStore';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { invalidatePromptLibraryCatalogProjection, resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { useRoleCatalog } from './useRoleCatalog';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { AccountSettingsV2HistoryMutationRequestSchema, AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

installDisconnectedServerSocketBoundary();

describe('fresh Role catalog readiness', () => {
    it('renders authoritative rows before history cleanup and revalidates a wake during cleanup', async () => {
        await loadSyncSingletonForTests();
        const bridge = await loadVitestModuleForNodeRequire(
            new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        onTestFinished(bridge.dispose);
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        onTestFinished(() => { resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });
        const history = createDeferred<Response>();
        let historyPending = false;
        let historyReads = 0;
        let retained: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { rolesV1: { overrides: {} }, preferredLanguage: 'de' } };
        const historyInventory = { snapshots: [{ version: 7, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100 }] };
        let revision = 1;
        let sourceVersion = 7;
        let sourceRaw: Record<string, unknown> = { rolesV1: { overrides: {} } };
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://role-history-readiness.example.test', accountId: 'alice',
            // Only Home HTTP is substituted; catalog, transfer, lifetime and Action paths stay real.
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }));
                if (path === '/v2/account/settings') {
                    if (init?.method === 'POST') {
                        const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                        expect(mutation.expectedVersion).toBe(sourceVersion);
                        if (mutation.content?.t !== 'plain') throw new Error('fixture_requires_plain');
                        sourceRaw = mutation.content.v;
                        sourceVersion += 1;
                        // The confirmed source CAS produces the ordinary Account wake.
                        publishHomeAccountChange(connection.home.id, ['self']);
                        return Response.json({ success: true, version: sourceVersion });
                    }
                    return Response.json({ content: { t: 'plain', v: sourceRaw }, version: sourceVersion });
                }
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
                if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed',
                    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision, content: { t: 'plain',
                        v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
                            builder: { roleId: 'builder', instructionsOverride: `Revision ${revision}` },
                        } } } : emptyPromptLibraryRecordV1(key) } })) });
                if (path === '/v2/account/settings/history') {
                    historyPending = true;
                    historyReads += 1;
                    return historyReads === 1 ? history.promise : Response.json(historyInventory);
                }
                if (path === '/v2/account/settings/history/7') return Response.json({ version: 7,
                    createdAt: '2026-01-01T00:00:00.000Z', content: retained });
                if (path === '/v2/account/settings/history/7/mutate') {
                    const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init?.body)));
                    expect(mutation.expectedContent).toEqual(retained);
                    if (mutation.expectedSettingsVersion !== sourceVersion) return Response.json({ status: 'conflict' }, { status: 409 });
                    if (mutation.operation.kind !== 'normalize' || !mutation.operation.content) throw new Error('fixture_requires_normalization');
                    retained = mutation.operation.content;
                    return Response.json({ status: 'applied' });
                }
                return new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        const scope = { serverId: connection.home.id, accountId: 'alice' };
        storage.getState().activateProfileScope(scope);
        const hook = await renderHook(() => useRoleCatalog());
        onTestFinished(() => history.resolve(Response.json({ snapshots: [] })));
        await vi.waitFor(() => expect(historyPending).toBe(true));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(sourceRaw).toEqual({});
        expect(hook.getCurrent().entries.find(item => item.roleId === 'builder')?.role.instructions).toBe('Revision 1');
        let refresh!: Promise<void>;
        await act(async () => {
            revision = 2;
            refresh = invalidatePromptLibraryCatalogProjection(scope);
            expect(getPromptLibraryCatalogValue(scope, 'role-overrides').stale).toBe(true);
            await refresh;
        });
        expect(hook.getCurrent().entries.find(item => item.roleId === 'builder')?.role.instructions).toBe('Revision 2');
        await act(async () => {
            revision = 3;
            // A later writer introduced new source work after the incumbent CAS.
            // Deferring it during maintenance must not drop its mandatory cleanup.
            sourceRaw = { rolesV1: { overrides: {} } };
            sourceVersion += 1;
            await invalidatePromptLibraryCatalogProjection(scope);
        });
        expect(hook.getCurrent().entries.find(item => item.roleId === 'builder')?.role.instructions).toBe('Revision 3');
        expect(historyReads).toBe(1);
        await act(async () => { history.resolve(Response.json(historyInventory)); });
        await vi.waitFor(() => expect(sourceRaw).toEqual({}));
        await vi.waitFor(() => expect(retained).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().entries.find(item => item.roleId === 'builder')?.role.instructions).toBe('Revision 3');
        expect(getPromptLibraryCatalogSnapshot(scope)?.catalog.status).toBe('ready');
    });
});
