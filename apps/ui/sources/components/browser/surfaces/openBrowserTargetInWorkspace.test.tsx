import type {
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
    FeatureDecision,
    LocalServiceLaunchTargetV1,
    ApprovalRequest,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';

// The OS-tab handoff is a genuine platform boundary (`window.open` / `Linking.openURL`); the
// selection and fulfilment logic beneath it stays real.
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
const machineRpcMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpcMock }));

import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import {
    getLocalServicePreviewState,
    resetLocalServicePreviewStoreForTests,
    subscribeLocalServicePreviewStore,
} from '@/sync/domains/local/services/preview/sharedStore';

import {
    bindServicesOpenInBrowser,
    mapLocalServiceLaunchTargetToBrowserTarget,
    resolveBrowserViewTargetOpen,
    resolveBrowserViewTargetOpenTab,
    resolveBrowserTargetOpenOptions,
} from './openBrowserTargetInWorkspace';
import { readBrowserViewDetailsResource } from './browserSurfaceDetailsTabModel';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

const localServicePreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_123',
    sessionId: 'session_123',
    machineId: 'machine_123',
    display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
    },
} satisfies BrowserViewTargetV1;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_1',
    url: 'https://example.com/',
    display: {
        title: 'Example',
        addressLabel: 'example.com',
    },
} satisfies BrowserViewTargetV1;

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

const disabledOpeningSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'browser.workspace.open': { enabled: false } } });
const confirmOpeningSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'browser.workspace.open': { approvalRequiredSurfaces: ['ui'] } } });
const requiresOpeningApproval = (id: Parameters<typeof isApprovalRequiredByActionsSettings>[0], context: Parameters<typeof isApprovalRequiredByActionsSettings>[2]) =>
    isApprovalRequiredByActionsSettings(id, confirmOpeningSettings, context);

const sessionBrowserProfile = {
    profileId: 'profile_session_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

const availableDesktopWebView = {
    available: true,
    platform: 'macos',
    primitive: 'macosNsViewWebKit',
    renderEngine: 'desktopWebView',
    producer: 'tauriWryNativeChildView',
    privilegedIpc: false,
    supports: {
        navigation: true,
        goBackForward: false,
        reload: false,
        stop: false,
        pageInfoDiagnostics: true,
        nativeDevtools: true,
        capture: false,
        recording: false,
        automation: false,
    },
    disabledReasons: [],
} as const;

/** A RESOLVED desktop probe that says this host cannot embed a third-party site (Windows/X11). */
const unembeddableDesktopWebView = {
    ...availableDesktopWebView,
    available: false,
    platform: 'windows',
    primitive: 'windowsHwndWebView2',
    renderEngine: 'unavailable',
    producer: 'none',
    supports: { ...availableDesktopWebView.supports, navigation: false },
    disabledReasons: ['desktop_webview_child_view_unverified'],
} as const;

const serviceTargetWithBrowserTarget = {
    id: 'inventory:svc_1',
    source: 'inventory_entry',
    machineId: 'machine_123',
    sessionId: 'session_123',
    title: 'Kitchen Sink',
    subtitle: 'localhost:5173',
    confidence: 'high',
    state: 'available',
    actions: ['open_preview'],
    browserTarget: localServicePreviewTarget,
} satisfies LocalServiceLaunchTargetV1;

const serviceTargetWithoutBrowserTarget = {
    id: 'inventory:svc_2',
    source: 'inventory_entry',
    machineId: 'machine_123',
    sessionId: 'session_123',
    title: 'Detached Service',
    subtitle: 'localhost:6000',
    confidence: 'medium',
    state: 'unavailable',
    unavailableReason: 'preview_unregistered',
    actions: [],
} satisfies LocalServiceLaunchTargetV1;

function readTabTarget(tab: DetailsTab): BrowserViewTargetV1 | undefined {
    const resource = tab.resource as { target?: BrowserViewTargetV1 };
    return resource.target;
}

function readTabBrowserSessionId(tab: DetailsTab): string | undefined {
    const resource = tab.resource as { browserSessionId?: string };
    return resource.browserSessionId;
}

describe('openBrowserTargetInWorkspace', () => {
    it('opens an already bound daemon stream without fabricating a local profile policy', () => {
        const options = resolveBrowserTargetOpenOptions({ browserSessionId: 'daemon-session', platform: 'web',
            target: { kind: 'streamedBrowser', targetId: 'source', streamId: 'source',
                daemonView: { browserSessionId: 'daemon-session', viewId: 'daemon-view' } } });
        expect(options).not.toHaveProperty('targetPolicyDecision');
    });
    afterEach(() => {
        resetLocalServicePreviewStoreForTests();
        machineRpcMock.mockReset();
        clearBrowserRuntimeControlRegistryForTests();
    });
    it('Action admission: disabling workspace opening prevents both a workspace tab and an OS tab', async () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        for (const platform of ['web', 'desktop'] as const) {
            const { open, dispose } = createBrowserWorkspaceOpeningFixture({
                openDetailsTab,
                scope: 'sessionDetails',
                platform,
                browserFeatureDecision: enabledBrowserDecision,
                desktopWebViewAvailability: unembeddableDesktopWebView,
            }, { isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, disabledOpeningSettings, context) });
            expect(await open(externalTarget)).toMatchObject({ ok: false });
            dispose();
        }
        expect(openDetailsTab).not.toHaveBeenCalled();
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });
    it('Action admission: rejection prevents both tab creation and OS opening', async () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        for (const platform of ['web', 'desktop'] as const) {
            let stored: ApprovalRequest | null = null;
            const { open, executor, context, dispose } = createBrowserWorkspaceOpeningFixture({ openDetailsTab, scope: 'sessionDetails',
                platform, browserFeatureDecision: enabledBrowserDecision, desktopWebViewAvailability: unembeddableDesktopWebView }, {
                isActionApprovalRequired: requiresOpeningApproval,
                // Account-private approval Artifact storage is a system boundary. Its lifecycle,
                // transition and replay remain the real Action executor's responsibility.
                approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'approval_1' }; },
                approvalsGet: async () => stored,
                approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
                approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
            });
            // UI retains the canonical durable approval flow; it must not open while pending.
            expect(await open(externalTarget)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(openDetailsTab).not.toHaveBeenCalled();
            expect(openExternalUrlMock).not.toHaveBeenCalled();
            expect(await executor.execute('approval.request.decide', { artifactId: 'approval_1', decision: 'reject' },
                { ...context, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            expect(await executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'agent_rejected', target: externalTarget },
                { ...context, surface: 'agent', authority: 'account_automation' }))
                .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
            dispose();
        }
        expect(openDetailsTab).not.toHaveBeenCalled();
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });
    it('Agent default Ask first admits the same deterministic target as UI without a mounted Browser view', async () => {
        const tabs: DetailsTab[] = [];
        const approvals: string[] = [];
        const { open, executor, context } = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web',
            openDetailsTab: tab => { tabs.push(tab); } }, {
            approvalsCreate: async ({ request }) => { approvals.push(request.actionId); return { artifactId: 'approval_1' }; },
            approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve', decisionAuthority: 'present_user', request }),
        });
        expect(await open(localServicePreviewTarget)).toMatchObject({ ok: true });
        expect(await executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'agent_open',
            target: localServicePreviewTarget }, { ...context, surface: 'agent', authority: 'account_automation' }))
            .toMatchObject({ ok: true, result: { commandId: 'agent_open', status: 'dispatched' } });
        expect(approvals).toEqual(['browser.workspace.open']);
        expect(tabs).toHaveLength(2);
        expect(tabs[1]).toEqual(tabs[0]);
        expect(Object.keys(tabs[1].resource as Record<string, unknown>).sort())
            .toEqual(['browserSessionId', 'kind', 'target', 'viewId']);
    });
    it('a UI open from a side list lends its column to the scope\'s opener; an Agent open lends none', async () => {
        // Services (side column) and a Details panel share one scope; the panel's opener mounts last
        // and keeps deciding the open (platform, policy, tab).
        const servicesOpen = vi.fn();
        const panelOpen = vi.fn();
        const services = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web',
            openDetailsTab: servicesOpen, readOpenerRegion: () => 'side' });
        const panel = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web', openDetailsTab: panelOpen });
        expect(await services.open(localServicePreviewTarget)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        expect(servicesOpen).not.toHaveBeenCalled();
        expect(panelOpen).toHaveBeenCalledTimes(1);
        expect(panelOpen.mock.calls[0]?.[1]).toEqual({ intent: 'default', origin: 'side' });
        // An Agent has no UI column: the same Action still opens, with the owner's own region.
        expect(await panel.executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'agent_open',
            target: localServicePreviewTarget }, { ...panel.context, surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { commandId: 'agent_open', status: 'dispatched' } });
        expect(panelOpen).toHaveBeenCalledTimes(2);
        expect(panelOpen.mock.calls[1]?.[1]).toEqual({ intent: 'default' });
    });
    it('does not resolve an absent workspace or another Home/Account with the same scope id', async () => {
        const openDetailsTab = vi.fn();
        const { executor, context } = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web', openDetailsTab });
        const input = { scopeId: 'workspace_1', commandId: 'agent_open', target: localServicePreviewTarget };
        for (const request of [
            { input: { ...input, scopeId: 'absent' }, context },
            { input, context: { ...context, serverId: 'other_home' } },
            { input, context: { ...context, runtimeAccountId: 'other_account' } },
        ]) {
            expect(await executor.execute('browser.workspace.open', request.input, { ...request.context, surface: 'ui', authority: 'present_user' }))
                .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        }
        expect(openDetailsTab).not.toHaveBeenCalled();
    });
    it('opens the canonical Home workspace from the approving device profile without accepting another Account', async () => {
        const tabs: DetailsTab[] = [];
        let stored: ApprovalRequest | null = null;
        const { executor, context, dispose } = createBrowserWorkspaceOpeningFixture({
            scope: 'sessionDetails', platform: 'web', openDetailsTab: tab => { tabs.push(tab); },
            accountLifetime: {
                scope: { serverId: 'srv_browser_workspace_alias', accountId: 'account_1' },
                isCurrent: () => true, onRetire: () => ({ dispose: () => {} }),
            },
        }, {
            // Only Account-private approval storage is replaced; replay and Browser owners stay real.
            approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'profile-open-approval' }; },
            approvalsGet: async () => stored,
            approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
        });
        const profile = await upsertServerProfile({ serverUrl: 'https://browser-workspace-alias.example.test', name: 'Browser workspace' });
        try {
            expect(await setServerProfileIdentityForUrl(profile.serverUrl, context.serverId))
                .toMatchObject({ serverIdentityId: context.serverId });
            const input = { scopeId: 'workspace_1', commandId: 'approved_profile_open', target: localServicePreviewTarget };
            const approvingContext = { ...context, serverId: profile.id, surface: 'ui' as const, authority: 'present_user' as const };
            expect(await executor.execute('browser.workspace.open', input, {
                ...approvingContext, runtimeAccountId: 'another_account',
            })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
            expect(tabs).toHaveLength(0);
            expect(await executor.execute('browser.workspace.open', input, approvingContext))
                .toMatchObject({ ok: true, result: { commandId: 'approved_profile_open', status: 'dispatched' } });
            expect(tabs).toHaveLength(1);
            expect(await executor.execute('browser.workspace.open', { ...input, commandId: 'profile_approval_replay' }, {
                ...approvingContext, actionsSettings: confirmOpeningSettings,
            })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(tabs).toHaveLength(1);
            expect(await executor.execute('approval.request.decide', {
                artifactId: 'profile-open-approval', decision: 'approve',
            }, approvingContext)).toMatchObject({ ok: true });
            expect(stored).toMatchObject({ status: 'executed', execution: { ok: true,
                result: { commandId: 'profile_approval_replay', status: 'dispatched' } } });
            expect(tabs).toHaveLength(2);
        } finally {
            dispose();
            await removeServerProfile(profile.id);
        }
    });
    it('reports an OS refusal without creating a substitute workspace tab', async () => {
        const openDetailsTab = vi.fn();
        openExternalUrlMock.mockResolvedValueOnce(false);
        const { open } = createBrowserWorkspaceOpeningFixture({ openDetailsTab, scope: 'sessionDetails', platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision, desktopWebViewAvailability: unembeddableDesktopWebView });
        expect(await open(externalTarget)).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(openDetailsTab).not.toHaveBeenCalled();
    });
    it('refuses oversized command correlation before effects and accepts the existing dispatch boundary', async () => {
        const openDetailsTab = vi.fn();
        const { executor, context } = createBrowserWorkspaceOpeningFixture({ openDetailsTab, scope: 'sessionDetails', platform: 'web' });
        const input = { scopeId: 'workspace_1', target: localServicePreviewTarget };
        expect(await executor.execute('browser.workspace.open', { ...input, commandId: 'x'.repeat(257) },
            { ...context, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(openDetailsTab).not.toHaveBeenCalled();
        expect(await executor.execute('browser.workspace.open', { ...input, commandId: 'x'.repeat(256) },
            { ...context, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        expect(openDetailsTab).toHaveBeenCalledTimes(1);
    });
    it('revalidates captured Home and workspace policy after an approval wait', async () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        for (const retiredHome of [false, true]) {
            let approve!: () => void;
            let waiting!: () => void;
            const decision = new Promise<void>(resolve => { approve = resolve; });
            const started = new Promise<void>(resolve => { waiting = resolve; });
            let allowExternalUrlBrowsing = true;
            const facts = { scope: 'sessionDetails' as const, platform: 'desktop' as const,
                browserFeatureDecision: enabledBrowserDecision, desktopWebViewAvailability: unembeddableDesktopWebView };
            const { executor, context, retire, dispose } = createBrowserWorkspaceOpeningFixture({ ...facts, openDetailsTab,
                readOpenFacts: () => ({ ...facts, allowExternalUrlBrowsing }) }, {
                isActionApprovalRequired: requiresOpeningApproval,
                approvalsCreate: async () => ({ artifactId: 'approval_1' }),
                approvalsWaitForDecision: async ({ request }) => {
                    waiting(); await decision; return { decision: 'approve', decisionAuthority: 'present_user', request };
                },
            });
            const result = executor.execute('browser.workspace.open', { scopeId: 'workspace_1', commandId: 'agent_wait', target: externalTarget },
                { ...context, surface: 'agent', authority: 'account_automation' });
            // Fail visibly if admission settles before reaching the approval port; never wait
            // indefinitely on a fixture that did not enter the intended real approval path.
            await Promise.race([started, Promise.resolve(result).then(value => { throw new Error(JSON.stringify(value)); })]);
            if (retiredHome) retire(); else allowExternalUrlBrowsing = false;
            approve();
            expect(await result).toMatchObject({ ok: false });
            dispose();
        }
        expect(openDetailsTab).not.toHaveBeenCalled();
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });
    it('opens the actual source-qualified managed service without retargeting a launch id or Session', async () => {
        const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_123', managedServiceId: 'actual-instance',
            workspaceId: 'workspace_1', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } };
        const browserTarget = { ...localServicePreviewTarget, sessionId: undefined };
        const resource = { previewId: browserTarget.targetId, machineId: serviceTarget.machineId,
            owner: { kind: 'user', id: 'starter' }, serviceTarget, browserTarget,
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
            display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host' };
        const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview.example.test/?previewToken=current',
            expiresAt: 61_000, diagnostics: [] };
        machineRpcMock.mockImplementationOnce(async ({ payload }) => {
            // Machine RPC is the network boundary; canonical UI mapping/parsing remain real.
            if (!isDeepStrictEqual(payload, { machineId: serviceTarget.machineId, serviceTarget })) {
                throw new Error('local_service_preview_lifecycle_refused:preview_target_unresolved');
            }
            return { protocolVersion: 1, status: 'existing', preview, snapshot: { v: 1, machineId: resource.machineId,
                generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } };
        });
        const opened: BrowserViewTargetV1[] = [];
        const open = bindServicesOpenInBrowser({ onOpenTarget: target => { opened.push(target); }, platform: 'web', sessionId: 'viewing-session' });
        expect(await open({ ...serviceTargetWithBrowserTarget, source: 'managed_service', id: 'service-row', sessionId: undefined,
            sourceClass: { kind: 'managed_service', managedServiceId: serviceTarget.managedServiceId }, workspaceId: serviceTarget.workspaceId,
            cwd: serviceTarget.cwd, declaration: serviceTarget.declaration, browserTarget: undefined, actions: ['open_preview'] }))
            .toEqual({ status: 'succeeded' });
        expect(opened).toEqual([browserTarget]);
    });
    it('resolves a target into BOTH a details-workspace tab AND a live content record (one identity)', () => {
        const resolved = resolveBrowserViewTargetOpen({
            scope: 'sessionDetails',
            platform: 'web',
        }, localServicePreviewTarget);

        // (a) a canonical browser-view details tab carrying the target + a stable browserSessionId
        expect(resolved.tab.kind).toBe('browser-view');
        expect(readTabTarget(resolved.tab)).toEqual(localServicePreviewTarget);
        const browserSessionId = readTabBrowserSessionId(resolved.tab);
        expect(browserSessionId).toEqual(expect.any(String));
        expect((browserSessionId ?? '').length).toBeGreaterThan(0);

        // (b) the live content record materializes for that exact browserSessionId/viewId
        const viewId = resolveBrowserViewIdForTarget(localServicePreviewTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.target).toEqual(localServicePreviewTarget);
        expect(record?.browserSessionId).toBe(browserSessionId);
        expect(resolved.seededState.currentTarget).toEqual(localServicePreviewTarget);
    });

    it('opens the tab once with intent default and remembers the recent target', async () => {
        const openDetailsTab = vi.fn();
        const remembered: BrowserViewTargetV1[] = [];
        const { open: openBrowserViewTarget } = createBrowserWorkspaceOpeningFixture({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'web',
            onRememberRecentTarget: (target) => {
                remembered.push(target);
            },
        });

        await openBrowserViewTarget(localServicePreviewTarget);

        expect(openDetailsTab).toHaveBeenCalledTimes(1);
        const [tab, options] = openDetailsTab.mock.calls[0] as [DetailsTab, { intent?: string } | undefined];
        expect(tab.kind).toBe('browser-view');
        expect(readTabTarget(tab)).toEqual(localServicePreviewTarget);
        expect(options?.intent).toBe('default');
        expect(remembered).toEqual([localServicePreviewTarget]);
    });

    it('DV-OPEN-SEAM: the opened tab resource carries ONLY the deterministic inputs (target + identity), no state blob', async () => {
        const openDetailsTab = vi.fn();
        const { open: openBrowserViewTarget } = createBrowserWorkspaceOpeningFixture({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'web',
        });

        await openBrowserViewTarget(localServicePreviewTarget);

        const [tab] = openDetailsTab.mock.calls[0] as [DetailsTab];
        // The resource narrows to the canonical single-view shape: { kind, browserSessionId, viewId, target }.
        const resource = readBrowserViewDetailsResource(tab.resource);
        expect(resource).not.toBeNull();
        expect(resource?.target).toEqual(localServicePreviewTarget);
        // No materialized BrowserViewState / seededState blob is attached to the resource (the divergent
        // second content path DV-OPEN-SEAM forbids).
        const rawKeys = Object.keys(tab.resource as Record<string, unknown>).sort();
        expect(rawKeys).toEqual(['browserSessionId', 'kind', 'target', 'viewId']);
        expect((tab.resource as Record<string, unknown>).seededState).toBeUndefined();
        expect((tab.resource as Record<string, unknown>).browserState).toBeUndefined();
        expect((tab.resource as Record<string, unknown>).viewsById).toBeUndefined();
    });

    it('DV-OPEN-SEAM: the tab-only opener path does not expose a materialized state (the opener does no throwaway seed)', () => {
        const resolvedTab = resolveBrowserViewTargetOpenTab({
            scope: 'sessionDetails',
            platform: 'web',
        }, localServicePreviewTarget);
        expect('seededState' in resolvedTab).toBe(false);
        expect(resolvedTab.tab.kind).toBe('browser-view');
    });

    it('maps only an authoritative service browser target without inventing a preview identity', () => {
        expect(mapLocalServiceLaunchTargetToBrowserTarget(serviceTargetWithBrowserTarget))
            .toEqual(localServicePreviewTarget);

        expect(mapLocalServiceLaunchTargetToBrowserTarget(serviceTargetWithoutBrowserTarget)).toBeNull();

        expect(mapLocalServiceLaunchTargetToBrowserTarget({
            ...serviceTargetWithoutBrowserTarget,
            machineId: '',
        } as LocalServiceLaunchTargetV1)).toBeNull();
    });

    it('refuses inventory registration without a projected inventory identity', async () => {
        const open = bindServicesOpenInBrowser({ onOpenTarget: vi.fn(), platform: 'web' });
        expect(await open({ ...serviceTargetWithBrowserTarget, sourceClass: undefined,
            browserTarget: undefined, actions: ['register_preview'] })).toEqual({ status: 'denied', reasonCode: 'browser_target_unavailable' });
        expect(machineRpcMock).not.toHaveBeenCalled();
    });

    it('registers a detected service through the server preview owner before opening its returned URL', async () => {
        // The loaded Browser/Services surface subscribes to this canonical store key.
        const unsubscribe = subscribeLocalServicePreviewStore({ machineId: 'machine_123' }, () => {}, {
            snapshotClient: async () => ({ ok: true, snapshot: { generatedAt: 0, refreshState: 'idle', previews: [], diagnostics: [] } }),
        });
        await Promise.resolve();
        await Promise.resolve();
        const target: LocalServiceLaunchTargetV1 = { ...serviceTargetWithBrowserTarget, id: 'opaque-launcher-target', browserTarget: undefined, actions: ['register_preview'], sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'svc_1' } };
        const resource = {
            previewId: 'preview_123', sessionId: 'session_123', machineId: 'machine_123',
            owner: { kind: 'session', id: 'session_123' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Kitchen Sink', addressLabel: 'localhost:5173' }, originMode: 'host', browserTarget: localServicePreviewTarget,
        } as const;
        const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview-123.preview.test/?previewToken=fresh', expiresAt: 61_000, diagnostics: [] };
        machineRpcMock.mockResolvedValueOnce({ protocolVersion: 1, status: 'created', preview, snapshot: { v: 1, machineId: resource.machineId, generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } });
        const openDetailsTab = vi.fn();
        const { open } = createBrowserWorkspaceOpeningFixture({ openDetailsTab, scope: 'sessionDetails', platform: 'web' });
        const openInBrowser = bindServicesOpenInBrowser({ onOpenTarget: open, platform: 'web' });
        expect(await openInBrowser(target)).toEqual({ status: 'succeeded' });
        expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine_123', payload: { machineId: 'machine_123', sessionId: 'session_123', inventoryEntryId: 'svc_1' } }));
        const [tab] = openDetailsTab.mock.calls[0] as [DetailsTab];
        expect(readTabTarget(tab)).toEqual(localServicePreviewTarget);
        expect(getLocalServicePreviewState({ machineId: 'machine_123' }).previewsById.get('preview_123')?.accessUrl).toBe(preview.accessUrl);

        // Reopening must ask the same owner for a new admission, never reuse the snapshot URL.
        const reopenedPreview = { ...preview, accessUrl: 'https://preview-123.preview.test/?previewToken=reopened' };
        machineRpcMock.mockResolvedValueOnce({ protocolVersion: 1, status: 'existing', preview: reopenedPreview, snapshot: { v: 1, machineId: resource.machineId, generatedAt: 62_000, refreshState: 'idle', resources: [resource], previews: [reopenedPreview], diagnostics: [] } });
        const onOpenTarget = vi.fn();
        const reopen = bindServicesOpenInBrowser({ onOpenTarget, platform: 'web' });
        expect(await reopen({ ...target, browserTarget: localServicePreviewTarget, actions: ['open_preview'] })).toEqual({ status: 'succeeded' });
        expect(onOpenTarget).toHaveBeenCalledWith(localServicePreviewTarget, { platform: 'web', currentUrl: reopenedPreview.accessUrl });
        expect(getLocalServicePreviewState({ machineId: 'machine_123' }).previewsById.get('preview_123')?.accessUrl).toBe(reopenedPreview.accessUrl);

        // The typed no-private-domain response preserves the existing Elsewhere + Share surface.
        const elsewherePreview = { ...preview, accessUrl: null, expiresAt: null, accessUnavailableReasonCode: 'preview_private_route_unavailable' };
        machineRpcMock.mockResolvedValueOnce({ protocolVersion: 1, status: 'existing', preview: elsewherePreview, snapshot: { v: 1, machineId: resource.machineId, generatedAt: 63_000, refreshState: 'idle', resources: [resource], previews: [elsewherePreview], diagnostics: [] } });
        onOpenTarget.mockClear();
        expect(await reopen(target)).toEqual({ status: 'succeeded' });
        expect(onOpenTarget).toHaveBeenCalledWith(localServicePreviewTarget, { platform: 'web' });
        expect(getLocalServicePreviewState({ machineId: 'machine_123' }).previewsById.get('preview_123')?.accessUnavailableReasonCode).toBe('preview_private_route_unavailable');

        machineRpcMock.mockRejectedValueOnce(new Error('local_service_preview_lifecycle_refused:preview_registration_failed'));
        onOpenTarget.mockClear();
        expect(await reopen(target)).toEqual({ status: 'denied', reasonCode: 'preview_registration_failed' });
        expect(onOpenTarget).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('binds an external service target to the browser opener and refuses an unmappable target', async () => {
        const openDetailsTab = vi.fn();
        const { open } = createBrowserWorkspaceOpeningFixture({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'web',
            browserFeatureDecision: enabledBrowserDecision,
        });
        const openInBrowser = bindServicesOpenInBrowser({ onOpenTarget: open, platform: 'web' });

        await openInBrowser({ ...serviceTargetWithBrowserTarget, source: 'terminal_url', browserTarget: externalTarget });
        expect(openDetailsTab).toHaveBeenCalledTimes(1);
        const [tab] = openDetailsTab.mock.calls[0] as [DetailsTab];
        expect(readTabTarget(tab)).toEqual(externalTarget);

        openDetailsTab.mockClear();
        await openInBrowser({
            ...serviceTargetWithoutBrowserTarget,
            machineId: '',
        } as LocalServiceLaunchTargetV1);
        expect(openDetailsTab).not.toHaveBeenCalled();
    });

    it('preserves a registered preview resource scope instead of the viewing session', async () => {
        for (const sessionId of ['session_123', undefined]) {
            machineRpcMock.mockClear();
            const browserTarget = { ...localServicePreviewTarget, sessionId };
            const resource = {
                previewId: browserTarget.targetId, machineId: browserTarget.machineId, sessionId,
                owner: { kind: 'user', id: 'account_123' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                initialPath: { pathname: '/', search: '' }, display: { title: 'Kitchen Sink', addressLabel: 'localhost:5173' }, originMode: 'host', browserTarget,
            };
            const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview-123.preview.test/?previewToken=fresh', expiresAt: 61_000, diagnostics: [] };
            machineRpcMock.mockResolvedValueOnce({ protocolVersion: 1, status: 'existing', preview, snapshot: { v: 1, machineId: resource.machineId, generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } });
            const onOpenTarget = vi.fn();
            const open = bindServicesOpenInBrowser({ onOpenTarget, platform: 'web', sessionId: 'viewing_session' });
            expect(await open({
                ...serviceTargetWithBrowserTarget, source: 'registered_preview', browserTarget, sessionId,
            })).toEqual({ status: 'succeeded' });
            expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({
                payload: { machineId: 'machine_123', ...(sessionId ? { sessionId } : {}), launchTargetId: 'preview_123' },
            }));
            expect(onOpenTarget).toHaveBeenCalledWith(browserTarget, { platform: 'web', currentUrl: preview.accessUrl });
        }
    });

    it('honors a caller-resolved open: a row-provided policy + url seed the record without re-evaluating', () => {
        // The launchpad row resolves its own policy (it has the profile) and passes it via options.
        // The opener must trust that decision even though deps carries no profile/feature context.
        const allowedExternalPolicy = {
            targetKind: 'externalUrl',
            state: 'allowed',
            profileId: 'profile_session_1',
            profileMode: 'session',
            origin: 'https://example.com',
            security: {
                url: 'https://example.com/',
                origin: 'https://example.com',
                securityLevel: 'secure',
                reasonCodes: [],
            },
            permissions: {
                downloads: 'deny',
                uploads: 'deny',
                clipboard: 'deny',
                camera: 'deny',
                microphone: 'deny',
                fileAccess: 'deny',
                popups: 'deny',
                browserUse: 'prompt',
            },
            disabledReasons: [],
        } satisfies BrowserTargetPolicyDecisionV1;

        const resolved = resolveBrowserViewTargetOpen(
            { scope: 'sessionDetails', platform: 'desktop' },
            externalTarget,
            {
                platform: 'desktop',
                currentUrl: 'https://example.com/',
                targetPolicyDecision: allowedExternalPolicy,
                desktopWebViewAvailability: availableDesktopWebView,
            },
        );

        const viewId = resolveBrowserViewIdForTarget(externalTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.engineKind).toBe('desktopWebView');
        expect(record?.currentUrl).toBe('https://example.com/');
        // The browser-view tab seam is URL-free (the live URL lives on the seeded content record);
        // the tab carries the target + the same view identity, and the opener returns the URL.
        expect(readTabTarget(resolved.tab)).toEqual(externalTarget);
        expect(resolved.currentUrl).toBe('https://example.com/');
    });

    it('routes external-URL targets through policy: a denied target seeds no navigating content record', () => {
        const resolved = resolveBrowserViewTargetOpen({
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            // external browsing disabled => evaluateBrowserTargetPolicy denies the target
            allowExternalUrlBrowsing: false,
        }, externalTarget);

        // A tab still resolves (the user asked to open it)…
        expect(resolved.tab.kind).toBe('browser-view');
        // …but the denied policy yields no navigating content record (fail-closed).
        const viewId = resolveBrowserViewIdForTarget(externalTarget);
        expect(resolved.seededState.viewsById[viewId]).toBeUndefined();
    });

    it('seeds a navigating content record for an allowed external-URL target', () => {
        const resolved = resolveBrowserViewTargetOpen({
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            allowExternalUrlBrowsing: true,
            desktopWebViewAvailability: availableDesktopWebView,
        }, externalTarget);

        const viewId = resolveBrowserViewIdForTarget(externalTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.currentUrl).toBe('https://example.com/');
        expect(record?.engineKind).toBe('desktopWebView');
    });

    // R-3 (G9), second half. The selector already resolves an allowed site a desktop host cannot
    // embed to the fulfilled `openExternalTab` outcome, and `BrowserSurfaceHost` performs it for the
    // in-place seam. This NEW-TAB opener is the other production caller — reached by every ordinary
    // launchpad external row, the Services "open in browser" seam and the session-header button —
    // and it did not. The launchpad enables those rows (the selection is `ok`), so on Windows/Linux
    // clicking one opened a workspace tab whose `openView` is rejected as `adapter_unavailable`,
    // leaving an empty tab: the same dead end the fix was supposed to remove, one seam over.
    it('R-3: hands an allowed external URL to the system browser instead of opening a dead tab where the desktop host cannot embed it', async () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        const remembered: BrowserViewTargetV1[] = [];
        const { open: openBrowserViewTarget } = createBrowserWorkspaceOpeningFixture({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            allowExternalUrlBrowsing: true,
            desktopWebViewAvailability: unembeddableDesktopWebView,
            onRememberRecentTarget: (target) => {
                remembered.push(target);
            },
        });

        expect(await openBrowserViewTarget(externalTarget)).toMatchObject({ ok: true,
            result: { status: 'dispatched', adapterKind: 'externalUrl', outcome: 'externalTab' } });

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
        expect(openDetailsTab).not.toHaveBeenCalled();
        // An OS tab is not a workspace tab; it must not enter the recents rail as one.
        expect(remembered).toEqual([]);
    });

    // The neighbouring case: a host that CAN embed still opens the in-app tab. Discriminates
    // against "always hand external URLs to the OS".
    it('still opens a workspace tab for an allowed external URL the desktop host can embed', async () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        const { open: openBrowserViewTarget } = createBrowserWorkspaceOpeningFixture({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            allowExternalUrlBrowsing: true,
            desktopWebViewAvailability: availableDesktopWebView,
        });

        expect(await openBrowserViewTarget(externalTarget)).toMatchObject({ ok: true,
            result: { status: 'dispatched', outcome: 'workspaceTab' } });

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(openDetailsTab).toHaveBeenCalledTimes(1);
    });
});
