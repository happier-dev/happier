import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { createLocalServicesRuntimeActionExecutor } from '@/sync/domains/local/services/actions/runtimeActionExecutor';
import { fetchLocalServiceLauncherSnapshotViaMachineRpc } from '@/sync/domains/local/services/launch/machineRpc';
import { applyBrowserControlEvent, createBrowserControlState } from '../control';
import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { createBrowserRuntimeActionExecutor } from './runtimeActionExecutor';
import { clearBrowserRuntimeControlRegistryForTests } from './runtimeControlRegistry';
import { registerBrowserRuntimeControlAdapter } from './runtimeControlRegistry';
import { bindServicesOpenInBrowser, resolveBrowserViewTargetOpen } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import type { FeatureDecision } from '@happier-dev/protocol/features/decision';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

// The Machine RPC is the process/network boundary; registration, admission and control stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
// The OS browser is outside the owning process, as in the workspace opening testkit.
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));

const lifetime: ServerAccountScopeLifetime = { scope: { serverId: 'address_home', accountId: 'address_account' },
    isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) };
const previewTarget = { kind: 'localServicePreview', targetId: 'preview_address', machineId: 'machine_address',
    sessionId: 'session_address', display: { title: 'Web', addressLabel: 'localhost:5173' } } satisfies BrowserViewTargetV1;
const service = { id: 'inventory:web', source: 'inventory_entry', machineId: 'machine_address', sessionId: 'session_address',
    sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'web' },
    title: 'Web', confidence: 'high', state: 'available', actions: ['open_preview'], endpointUrl: 'http://127.0.0.1:5173/',
    browserTarget: previewTarget } satisfies LocalServiceLaunchTargetV1;
const external = { kind: 'externalUrl', targetId: 'external_address', url: 'http://localhost:5173/' } satisfies BrowserViewTargetV1;
const declaredService = { id: 'managed:web', source: 'managed_service', machineId: service.machineId,
    sourceClass: { kind: 'managed_service', managedServiceId: 'project-web' },
    cwd: '/work/address', declaration: { workspaceRefId: 'project_address', selection: { kind: 'manifest', name: 'web' } },
    title: 'Project Web', confidence: 'high', state: 'available', serviceState: 'running',
    endpointUrl: 'http://127.0.0.1:5173/', actions: ['register_preview'] } satisfies LocalServiceLaunchTargetV1;
const projectPreviewTarget = { kind: 'localServicePreview', targetId: previewTarget.targetId,
    machineId: service.machineId, display: previewTarget.display,
    serviceTarget: { kind: 'managed_service', managedServiceId: declaredService.sourceClass.managedServiceId,
        machineId: service.machineId, cwd: declaredService.cwd, declaration: declaredService.declaration } } satisfies BrowserViewTargetV1;
const context = { serverId: lifetime.scope.serverId, runtimeAccountId: lifetime.scope.accountId,
    expectedAccountId: lifetime.scope.accountId, defaultSessionId: 'session_address', bypassApprovals: true,
    authority: 'account_automation' as const, externalActionTarget: { kind: 'machine' as const, machineId: 'machine_address' } };
const browserFeatureDecision = { featureId: 'browser', state: 'enabled', blockedBy: null, blockerCode: 'none',
    diagnostics: [], evaluatedAt: 1_000, scope: { scopeKind: 'runtime' } } satisfies FeatureDecision;

function services(cold = false, project = false) {
    const resource = { previewId: previewTarget.targetId, machineId: service.machineId,
        ...(project ? { serviceTarget: projectPreviewTarget.serviceTarget } : { sessionId: service.sessionId }),
        owner: project ? { kind: 'user', id: lifetime.scope.accountId } : { kind: 'session', id: service.sessionId },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/', search: '' }, display: previewTarget.display, originMode: 'host',
        browserTarget: project ? projectPreviewTarget : previewTarget };
    const preview = { previewId: previewTarget.targetId, resource, accessUrl: 'https://address.preview.test/', expiresAt: 61_000, diagnostics: [] };
    machineRpc.mockResolvedValue({ protocolVersion: 1, status: 'existing', preview,
        snapshot: { v: 1, machineId: service.machineId, generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } });
    if (cold) machineRpc.mockResolvedValueOnce({ protocolVersion: 1,
        snapshot: { v: 1, machineId: service.machineId, ...(project ? {} : { sessionId: service.sessionId }),
            updatedAt: 1_000, targets: [project ? declaredService : service] } });
    return createLocalServicesRuntimeActionExecutor({ catalogBinding: { lifetime, credentialKey: 'address_credentials' },
        fetchLauncherSnapshot: fetchLocalServiceLauncherSnapshotViaMachineRpc });
}

afterEach(() => { machineRpc.mockReset(); clearBrowserRuntimeControlRegistryForTests(); });

it('opens an unregistered Project Service identically from Services Open and a workspace address', async () => {
    const openDetailsTab = vi.fn();
    const fixture = createBrowserWorkspaceOpeningFixture({ scope: 'workspaceDetails', platform: 'web', openDetailsTab,
        accountLifetime: lifetime, localServiceTargets: [declaredService] }, {
        runtimeActionExecute: createBrowserRuntimeActionExecutor({ fallback: services(false, true) }),
    });
    const openService = bindServicesOpenInBrowser({ onOpenTarget: fixture.open, platform: 'web', accountLifetime: lifetime,
        actionExecute: (id, input, caller) => fixture.executor.execute(id, input, { ...caller, ...context, defaultSessionId: undefined }) });
    try {
        expect(await openService(declaredService)).toMatchObject({ status: 'succeeded' });
        const openedServiceTarget = openDetailsTab.mock.calls.at(-1)?.[0].resource.target;
        expect(await fixture.executor.execute('browser.workspace.open', {
            scopeId: 'workspace_1', commandId: 'project-address', target: external,
        }, { ...context, defaultSessionId: undefined, surface: 'ui' })).toMatchObject({ ok: true });
        expect(openDetailsTab.mock.calls.at(-1)?.[0].resource.target).toEqual(openedServiceTarget);
        expect(openedServiceTarget).toEqual(projectPreviewTarget);
        expect(machineRpc).toHaveBeenCalledTimes(2);
        for (const [request] of machineRpc.mock.calls) expect(request.payload).toMatchObject({
            machineId: service.machineId, serviceTarget: { kind: 'managed_service', managedServiceId: 'project-web',
                cwd: '/work/address', declaration: declaredService.declaration },
        });
    } finally { fixture.dispose(); }
});

it('carries an initial embedded choice through the workspace resource and its renderer seed', async () => {
    const openDetailsTab = vi.fn();
    const facts = { scope: 'sessionDetails' as const, platform: 'ios' as const, browserFeatureDecision,
        localServiceAddressScope: { machineId: service.machineId, sessionId: service.sessionId } };
    const fixture = createBrowserWorkspaceOpeningFixture({ ...facts, openDetailsTab, accountLifetime: lifetime });
    const target = { ...external, url: 'https://example.com/docs' };
    try {
        expect(await fixture.open(target, { engineOverride: 'embedded' })).toMatchObject({ ok: true });
        const resource = openDetailsTab.mock.calls[0]?.[0].resource;
        expect(resource).toMatchObject({ target, engineOverride: 'embedded' });
        const seeded = resolveBrowserViewTargetOpen(facts, resource.target, { engineOverride: resource.engineOverride });
        expect(seeded.seededState.viewsById[resource.viewId]).toMatchObject({ target, engineKind: 'nativeWebView' });
    } finally { fixture.dispose(); }
});

it.each(['https://example.com/docs', 'http://localhost:42514/'])('opens the initial managed workspace page through its exact Machine and discovered stream source (%s)', async url => {
    const openDetailsTab = vi.fn();
    const target = { ...external, url };
    const facts = { scope: 'sessionDetails' as const, platform: 'web' as const, browserFeatureDecision, localServiceTargets: [],
        localServiceAddressScope: { machineId: service.machineId, sessionId: service.sessionId } };
    const resolved = resolveBrowserViewTargetOpen(facts, target);
    const daemonView = { browserSessionId: service.sessionId, viewId: resolved.viewId, sourceId: 'browser_capture',
        target, platform: 'web', adapterKind: 'chromiumSidecar', events: [], captureSource: {
            v: 1, sourceKind: 'browser', sourceId: 'browser_capture', supportedCodecs: ['image.mjpeg'],
            inputMode: 'shared', health: { status: 'available' },
        } };
    machineRpc.mockResolvedValue({ protocolVersion: 1, views: [daemonView] });
    const executeOnMachine = vi.fn<RuntimeActionExecute>(async args => ({ v: 1,
        commandId: typeof args.input === 'object' && args.input !== null && 'commandId' in args.input ? args.input.commandId : 'managed',
        status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }));
    const fixture = createBrowserWorkspaceOpeningFixture({ ...facts, openDetailsTab, accountLifetime: lifetime }, {
        runtimeActionExecute: createBrowserRuntimeActionExecutor({ executeOnMachine }),
    });
    try {
        expect(await fixture.open(target, { engineOverride: 'managed' })).toMatchObject({ ok: true, result: { outcome: 'workspaceTab' } });
        expect(executeOnMachine.mock.calls[0]?.[0]).toMatchObject({ actionId: 'browser.view.open',
            input: { target, browserSessionId: service.sessionId, engineOverride: 'managed' },
            context: { defaultSessionId: service.sessionId, externalActionTarget: { kind: 'machine', machineId: service.machineId } } });
        expect(machineRpc.mock.calls[0]?.[0]).toMatchObject({ method: RPC_METHODS.DAEMON_BROWSER_VIEW_LIST,
            machineId: service.machineId, payload: { browserSessionId: service.sessionId } });
        const opened = openDetailsTab.mock.calls[0]?.[0];
        expect(opened).toMatchObject({ key: resolved.tab.key, resource: { engineOverride: 'managed',
            browserSessionId: service.sessionId, viewId: resolved.viewId, target: { kind: 'streamedBrowser',
                streamId: daemonView.sourceId, daemonView: { browserSessionId: service.sessionId, viewId: resolved.viewId } } } });
    } finally { fixture.dispose(); }
});

it('switches an already open managed view to embedded even when its URL has not changed', async () => {
    const target = { ...external, url: 'https://example.com/docs' };
    const facts = { scope: 'sessionDetails' as const, platform: 'ios' as const, browserFeatureDecision,
        localServiceAddressScope: { machineId: service.machineId, sessionId: service.sessionId } };
    const seeded = resolveBrowserViewTargetOpen(facts, target);
    let state = applyBrowserControlEvent(seeded.seededState, { kind: 'viewOpened', eventId: 'managed',
        browserSessionId: seeded.browserSessionId, viewId: seeded.viewId, target, platform: 'ios',
        currentUrl: target.url, adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface', occurredAt: 1,
        adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
            supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'] }) });
    const unregister = registerBrowserRuntimeControlAdapter({ browserSessionId: seeded.browserSessionId,
        control: { accountLifetime: lifetime, readState: () => state, applyDispatchResult: result => { state = result.state; } } });
    const fixture = createBrowserWorkspaceOpeningFixture({ ...facts, openDetailsTab: vi.fn(), accountLifetime: lifetime });
    try {
        expect(await fixture.open(target, { engineOverride: 'embedded' })).toMatchObject({ ok: true });
        expect(state.viewsById[seeded.viewId]).toMatchObject({ target, engineKind: 'nativeWebView' });
    } finally { fixture.dispose(); unregister(); }
});

it.each(['ui', 'agent', 'mcp'] as const)('resolves a workspace address through the running Service owner from %s', async surface => {
    const openDetailsTab = vi.fn();
    const fixture = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web', openDetailsTab,
        accountLifetime: lifetime, localServiceTargets: [service] }, {
        runtimeActionExecute: createBrowserRuntimeActionExecutor({ fallback: services() }),
    });
    try {
        const result = await fixture.executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'address', target: external },
            { ...context, surface });
        expect(result).toMatchObject({ ok: true, result: { status: 'dispatched', outcome: 'workspaceTab' } });
        expect(openDetailsTab.mock.calls[0]?.[0].resource.target).toEqual(previewTarget);
        expect(machineRpc).toHaveBeenCalledTimes(1);
    } finally { fixture.dispose(); }
});

it.each([false, true])('resolves a cold workspace address from its owning Machine and root without a mounted launcher (Project: %s)', async project => {
    const openDetailsTab = vi.fn();
    const fixture = createBrowserWorkspaceOpeningFixture({ scope: 'workspaceDetails', platform: 'web', openDetailsTab,
        accountLifetime: lifetime, localServiceAddressScope: { machineId: service.machineId, scope: 'workspace', workspaceRoot: '/work/address' } }, {
        runtimeActionExecute: createBrowserRuntimeActionExecutor({ fallback: services(true, project) }),
    });
    try {
        expect(await fixture.executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'cold', target: external },
            { ...context, surface: 'agent', defaultSessionId: undefined })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        expect(openDetailsTab.mock.calls[0]?.[0].resource.target).toEqual(project ? projectPreviewTarget : previewTarget);
        expect(machineRpc.mock.calls[0]?.[0]).toMatchObject({ machineId: service.machineId, serverId: lifetime.scope.serverId,
            payload: { machineId: service.machineId, scope: 'workspace', workspaceRoot: '/work/address' } });
        expect(machineRpc).toHaveBeenCalledTimes(2);
    } finally { fixture.dispose(); }
});

it('leaves a non-Service address on its normal route without reading the launcher', async () => {
    const openDetailsTab = vi.fn();
    const fixture = createBrowserWorkspaceOpeningFixture({ scope: 'workspaceDetails', platform: 'ios', browserFeatureDecision, openDetailsTab,
        accountLifetime: lifetime, localServiceAddressScope: { machineId: service.machineId, scope: 'workspace', workspaceRoot: '/work/address' } }, {
        runtimeActionExecute: createBrowserRuntimeActionExecutor({ fallback: services() }),
    });
    const publicTarget = { ...external, url: 'https://example.com/docs' };
    try {
        expect(await fixture.executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'public', target: publicTarget },
            { ...context, surface: 'agent' })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        expect(openDetailsTab.mock.calls[0]?.[0].resource.target).toEqual(publicTarget);
        expect(machineRpc).not.toHaveBeenCalled();
    } finally { fixture.dispose(); }
});

it.each(['ui', 'agent', 'mcp'] as const)('resolves mounted navigation before Machine forwarding from %s and keeps explicit targets direct', async surface => {
    let state = applyBrowserControlEvent(createBrowserControlState(), { kind: 'viewOpened', eventId: 'open',
        browserSessionId: 'browser_address', viewId: 'view_address', target: external, platform: 'web',
        currentUrl: external.url, adapterKind: 'chromiumSidecar', engineKind: 'desktopWebView', occurredAt: 1,
        adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
            supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['desktopWebView'] }) });
    const forwarded: unknown[] = [];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: createBrowserRuntimeActionExecutor({
        control: { accountLifetime: lifetime, readState: () => state, readAddressFacts: () => ({ localServiceTargets: [service] }),
            applyDispatchResult: result => { state = result.state; } },
        fallback: services(), executeOnMachine: async args => { forwarded.push(args.input); return { v: 1,
            commandId: 'direct', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }; },
    }) }));
    const input = { kind: 'navigate' as const, commandId: 'address', browserSessionId: 'browser_address', viewId: 'view_address', url: external.url };
    expect(await executor.execute('browser.navigate', input, { ...context, surface })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
    // The daemon owns this view; address intent must reach it as the resolved target,
    // rather than forwarding localhost navigation to the answering browser.
    expect(forwarded).toEqual([expect.objectContaining({ kind: 'setTarget', target: previewTarget })]);
    expect(machineRpc).toHaveBeenCalledTimes(1);
    await executor.execute('browser.navigate', { ...input, commandId: 'direct', navigationIntent: 'target' }, { ...context, surface });
    expect(machineRpc).toHaveBeenCalledTimes(1);
});
