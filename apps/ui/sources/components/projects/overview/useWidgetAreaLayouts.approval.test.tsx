import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { useWidgetAreaLayouts } = await import('./useProjectDashboards');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { t } = await import('@/text');
const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { normalizePluginUiDestinationBindingV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
const { PluginUiWidgetAreaOperationV1Schema } = await import('@happier-dev/protocol/plugins/ui');
const { WidgetInstanceActionInputSchemasV1 } = await import('@happier-dev/protocol/widgets');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
let activeAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

async function addHome(options: Parameters<typeof homes.addHome>[0]) {
    const serverId = await homes.addHome(options);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(options.serverUrl);
    if (!credentials) throw new Error('Expected the saved layout Account');
    activeAccount = await restoreServerAccountForTest({ serverUrl: options.serverUrl,
        accountId: 'account-a', credentials, request: homes.request });
    return serverId;
}

beforeEach(async () => { standardCleanup(); await homes.reset(); retirePresentationNotice(); });
afterEach(async () => { standardCleanup(); await activeAccount?.dispose(); activeAccount = undefined; });

it('settles a dashboard refresh cancelled by scope retirement without rejecting', async () => {
    const serverId = await addHome({ name: 'Layouts', serverUrl: 'https://layout-cancel.test', accountId: 'account-a', currentAccount: true });
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-a' } };
    const hook = await renderHook(() => useWidgetAreaLayouts({ surface }));
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
    let started = false;
    // Genuine fetch cancellation; the hook, admission and Artifact inventory owners stay real.
    homes.answer(serverId, '/v1/artifacts', { select: async (_input, { signal }) => {
        started = true;
        await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal?.reason);
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
        });
        return undefined;
    } });
    const refresh = hook.getCurrent().reload();
    // Attach before unmount so RED is an asserted rejection, not a loose rejection.
    const settlement = expect(refresh).resolves.toBeNull();
    await vi.waitFor(() => expect(started).toBe(true));
    await hook.unmount();
    await settlement;
    expect(readPresentationNotice()).toBeNull();
});

it('keeps an unexpected network failure observable while the dashboard scope is current', async () => {
    const serverId = await addHome({ name: 'Layouts', serverUrl: 'https://layout-offline.test', accountId: 'account-a', currentAccount: true });
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-a' } };
    const hook = await renderHook(() => useWidgetAreaLayouts({ surface }));
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
    const failure = new TypeError('Failed to fetch');
    homes.answer(serverId, '/v1/artifacts', { select: async () => { throw failure; } });
    // The real Action owner maps this HTTP failure to an unavailable result.
    await act(async () => { await expect(hook.getCurrent().reload()).resolves.toBeNull(); });
    expect(hook.getCurrent().state.status).toBe('offline');
    await hook.unmount();
});

it.each(['approve', 'reject'] as const)('keeps named-layout creation pending until the exact approval is %s', async decision => {
    const serverId = await addHome({ name: 'Layouts', serverUrl: 'https://layout-approval.test', accountId: 'account-a', currentAccount: true });
    await homes.requireUiApproval(serverId, 'widgets.area.layout.create');
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-a' } };
    const hook = await renderHook(() => useWidgetAreaLayouts({ surface }));
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
    let settled = false;
    let operation!: ReturnType<ReturnType<typeof hook.getCurrent>['create']>;
    await act(async () => { operation = hook.getCurrent().create('Checks').then(result => { settled = true; return result; }); });
    await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'info', message: t('widgetAdd.areaApprovalPending') }));
    expect(settled).toBe(false);
    const artifact = homes.artifacts(serverId).list().find(row => homes.artifacts(serverId).readPlainBody(row.id)?.includes('approval_request'));
    // The durable request body is the Action owner's output; the test never invents a receipt.
    const approval = artifact ?? homes.artifacts(serverId).list().find(row => JSON.parse(homes.artifacts(serverId).readPlainBody(row.id)!).actionId === 'widgets.area.layout.create');
    expect(approval).toBeDefined();
    // useActionApprovalContinuation.ts projects the observer through useSyncExternalStore;
    // the external presentation notice does not establish that React committed that projection.
    await vi.waitFor(() => expect(hook.getCurrent().approvalId).toBe(approval!.id));
    expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    expect(await decideApprovalAsInbox(serverId, approval!.id, decision)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(settled).toBe(true));
    const outcome = await operation;
    if (decision === 'approve') {
        expect(outcome).toMatchObject({ ok: true, dashboard: { name: 'Checks' } });
        expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(true);
    } else {
        expect(outcome).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
        expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    }
    await hook.unmount();
});

it('keeps a human plugin-page layout write bound to its own rejection receipt', async () => {
    const serverId = await addHome({ name: 'Plugin layouts', serverUrl: 'https://plugin-layout-approval.test', accountId: 'account-a', currentAccount: true });
    await homes.requireUiApproval(serverId, 'widgets.area.layout.create');
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'pluginArea' as const,
        pluginId: 'example.checks', pageId: 'overview', area: 'pinned' } };
    const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'example.checks', destinationId: 'overview',
        container: 'appPage', target: { kind: 'app' }, rendererId: 'native', instancePolicy: 'singleton' });
    if (!binding) throw new Error('Expected a declared plugin page');
    const surfaceId = 'surfacePlacement:example.checks:overview';
    const controller = createBoundPluginSurfaceController({ facts: {
        pluginId: 'example.checks', contributionId: 'overview', surfaceId, placement: 'appPage', platform: 'web', serverId,
        accountLifetime: captureActiveServerAccountScopeLifetime(), interactionEnabled: true, daemonInteractionEnabled: false,
        pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: {
            [surfaceId]: { id: surfaceId, pluginId: 'example.checks', occurrenceId: 'current-occurrence',
                contributionKind: 'surfacePlacement', descriptorId: 'overview', binding, target: {}, renderer: {},
                display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
                widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', additionalProperties: false } }],
            },
        } },
    }, binding: { executeHostAction: scopedHomeActionExecutor({ serverId, accountId: 'account-a' }) } });
    // PluginPageWidgetArea lends this mounted host-control port, not a plugin-code invocation.
    const execute: import('./useProjectDashboards').WidgetAreaLayoutsExecute = (id, args) => {
        const fields = Object.fromEntries(Object.entries(WidgetInstanceActionInputSchemasV1[id].parse(args))
            .filter(([key]) => key !== 'surface'));
        return controller.widgetArea!({ area: 'pinned', operation: PluginUiWidgetAreaOperationV1Schema.parse({ ...fields, actionId: id }) });
    };
    const hook = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
    let operation!: ReturnType<ReturnType<typeof hook.getCurrent>['create']>;
    let settled = false;
    await act(async () => { operation = hook.getCurrent().create('Checks').then(result => { settled = true; return result; }); });
    // The mounted host-control port retains this human invocation through Ask.
    await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    expect(settled).toBe(false);
    expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({
        approval: { flow: 'blocking' },
        executionOriginV1: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
    });
    expect(await decideApprovalAsInbox(serverId, artifactId, 'reject')).toMatchObject({ ok: true });
    await expect(operation).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    await hook.unmount();
    controller.dispose();
});
