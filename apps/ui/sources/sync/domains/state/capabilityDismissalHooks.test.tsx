import { afterEach, expect, it, vi } from 'vitest';
import { act, createRenderCommitCounter, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createSkillsSurfaceItem } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogV1Schema, sealMcpServerCatalogContentV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
const { storage } = await import('./storage');
const uiState = await import('./persistentUiState');
const { createPersistentUiState } = uiState;
const { useSkillsFirstRun } = await import('@/components/settings/skills/firstRun/useSkillsFirstRun');
const { useMcpHome } = await import('@/components/settings/mcpServers/home/useMcpHome');
const { useCapabilityScope } = await import('@/components/capabilities/scope/useCapabilityScope');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');

afterEach(async () => {
    await standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    await resetPersistentUiStateForTest();
});

const items = [createSkillsSurfaceItem('waiting', { rules: [] })];
const place = { t: 'project', projectKey: 'project-a' } as const;
const cases = [
    { key: 'skillsFirstRunDecidedAt', useValue: () => {
        const value = useSkillsFirstRun(items);
        return { visible: value.eligible, dismiss: value.notNow };
    } },
    { key: 'mcpFirstVisitDismissedAt', useValue: () => {
        const value = useMcpHome();
        return { visible: value.model.firstVisitLine, dismiss: value.dismissFirstVisit };
    } },
    { key: 'projectSkillsMigrationNoteSeenAt', useValue: () => {
        const value = useCapabilityScope(place);
        return { visible: value.migrated.names.length > 0, dismiss: value.migrated.dismiss };
    } },
] as const;

it.each(cases)('$key persists through its real hook on this device and ignores unrelated settings and dismissal keys', async ({ key, useValue }) => {
    await resetPersistentUiStateForTest();
    const catalog = createPromptLibraryCatalogBoundary();
    const mcp = McpServerCatalogV1Schema.parse({ v: 1,
        servers: [{ id: 'local', name: 'local', transport: 'stdio', stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'migrated-stack:project:project-a:local', serverId: 'local', target: place, enabled: true, createdAt: 1, updatedAt: 1 }],
    });
    const content = sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog: mcp });
    const home = await createPlainArtifactHomeFixture(`https://device-${key.toLowerCase()}.test`, {
        handleRequest: async (path, init) => path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
            ? Response.json({ status: 'present', revision: 1, content })
            : path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
        handleExternalRequest: async () => Response.json({ version: 1, items: [] }),
    });
    const counter = createRenderCommitCounter();
    const mount = () => renderHook(() => { useRenderCommitCounter(counter); return useValue(); });
    let hook = await mount();
    try {
        await vi.waitFor(() => expect(hook.getCurrent().visible).toBe(true));
        counter.reset();
        const previousLocal = storage.getState().localSettings;
        const previousSettings = storage.getState().settings;
        for (let index = 0; index < 50; index += 1) {
            await act(async () => {
                storage.getState().applyLocalSettings({ debugMode: index % 2 === 0 });
                storage.getState().applySettingsLocal({ ...previousSettings, analyticsOptOut: index % 2 === 0 });
            });
        }
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => {
            storage.setState({ localSettings: previousLocal, settings: previousSettings });
            hook.getCurrent().dismiss();
        });
        expect(hook.getCurrent().visible).toBe(false);
        // A fresh projection reads the physical device KV, independent of the hook's retained value.
        const restored = createPersistentUiState('capability-dismissals-v1', value => value);
        expect(restored.read(key)).toEqual(expect.any(Number));
        expect(storage.getState().localSettings).toBe(previousLocal);
        await hook.unmount();
        hook = await mount();
        expect(hook.getCurrent().visible).toBe(false);
        counter.reset();
        await act(async () => {
            for (const other of cases) if (other.key !== key) uiState.capabilityDismissalState.set(other.key, 123);
        });
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        // A separate device has no dismissal: clear only the test's native persistence boundary.
        await act(async () => { await resetPersistentUiStateForTest(); });
        await vi.waitFor(() => expect(hook.getCurrent().visible).toBe(true));
    } finally {
        await hook.unmount();
        await home.dispose();
    }
});
