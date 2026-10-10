import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { applyPromptLibraryCatalogSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { BUILT_IN_ROLE_IDS_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { useRoleCatalog } from './useRoleCatalog';

installDisconnectedServerSocketBoundary();

describe('Role override catalog projection', () => {
    it('applies row restrictions on catalog-only refresh and withdraws authority when unavailable', async () => {
        await loadSyncSingletonForTests();
        const bridge = await loadVitestModuleForNodeRequire(
            new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        onTestFinished(bridge.dispose);
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://role-override-row.example.test', accountId: 'alice',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                    v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    declarationTransport: 'http-header-and-socket-auth-v1',
                } } });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 7 });
                if (path === '/v1/artifacts') return Response.json([]);
                return new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        const scope = { serverId: connection.home.id, accountId: 'alice' };
        storage.getState().activateProfileScope(scope);
        storage.setState({ settings: settingsDefaults, settingsScope: scope, settingsVersion: 7 });
        const roleId = BUILT_IN_ROLE_IDS_V1[0];
        function publish(instructionsOverride: string, revision: number) {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready',
                rows: [{ record: { key: 'role-overrides', value: { v: 1, overrides: {
                    [roleId]: { roleId, instructionsOverride, workspaceWrites: 'deny', secondOpinion: 'encouraged' },
                } } }, revision }], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        }
        publish('Row instructions', 4);
        const hook = await renderHook(() => useRoleCatalog());
        const entry = () => hook.getCurrent().entries.find(item => item.roleId === roleId);
        await vi.waitFor(() => expect(entry()?.role.instructions).toBe('Row instructions'));
        expect(entry()?.role).toMatchObject({ workspaceWrites: 'deny', secondOpinion: 'encouraged' });
        await act(async () => { publish('Changed on another client', 5); });
        expect(entry()?.role.instructions).toBe('Changed on another client');
        expect(storage.getState().settingsVersion).toBe(7);
        await act(async () => { applyPromptLibraryCatalogSnapshot(scope, {
            catalog: { status: 'unavailable', reason: 'forbidden' }, rawSettings: {}, sourceSettingsVersion: 7,
        }, true); });
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().entries).toEqual([]);
    });
});
