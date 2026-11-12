import * as React from 'react';
import { act } from 'react-test-renderer';
import type { BrowserViewTargetV1} from '@happier-dev/protocol/browser/target/v1';
import type { DaemonLocalServicePreviewOpenOrCreateResponseV1, LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { FeatureDecision} from '@happier-dev/protocol/features/decision';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets/suggestions';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import {
    resolveBrowserViewTargetOpen,
} from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { BrowserLaunchpad, type BrowserLaunchpadOpenTargetOptions } from './BrowserLaunchpad';
import type { BrowserSandboxInstallOutcome } from '@/sync/domains/browser/firstUse/browserFirstUse';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';

const machineRpcMock = vi.hoisted(() => vi.fn());
// Substitute Metro's module loader; Action admission and preview transport stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpcMock }));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const homes = createHomeGovernanceHarness();
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
let serverId: string;
const previewReceiver = vi.fn<(input: unknown) => DaemonLocalServicePreviewOpenOrCreateResponseV1>();
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Launchpad Home', serverUrl: 'https://launchpad.example.test',
        serverIdentityId: 'srv_launchpad_home', accountId: 'launchpad_account', currentAccount: true });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'launchpad_account' };
    storage.setState({ profileScope: scope, settingsScope: scope });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    machineRpcMock.mockReset();
    previewReceiver.mockReset().mockReturnValue(previewRegistrationResponse());
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine_1',
        actionId: 'localServices.preview.openOrCreate', tokenEpoch: 0, requesterInvocation: 'credentials', execute: previewReceiver });
});
afterEach(async () => { await homes.reset(); });

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

function previewRegistrationResponse(accessUrl = 'https://preview-vite.preview.test/?previewToken=fresh'): DaemonLocalServicePreviewOpenOrCreateResponseV1 {
    const resource: LocalServicePreviewResourceV1 = {
        previewId: 'preview_vite', sessionId: 'session_1', machineId: 'machine_1',
        owner: { kind: 'session', id: 'session_1' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/', search: '' }, display: { title: 'Vite app', addressLabel: 'localhost:5173' }, originMode: 'host', browserTarget: localPreviewTarget,
    };
    const preview = { previewId: resource.previewId, resource, accessUrl, expiresAt: 123_000, diagnostics: [] };
    return { protocolVersion: 1, status: 'existing', preview, snapshot: { v: 1, machineId: resource.machineId, generatedAt: 63_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } };
}

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_docs',
    url: 'https://docs.happier.test/',
    display: {
        title: 'Docs',
        addressLabel: 'docs.happier.test',
    },
} satisfies BrowserViewTargetV1;

const hostedPluginTarget = {
    kind: 'hostedPluginWeb',
    targetId: 'hosted_preview',
    pluginId: 'acme.preview',
    contributionId: 'previewPane',
    display: {
        title: 'Plugin preview',
        addressLabel: 'plugin://acme.preview/previewPane',
    },
} satisfies BrowserViewTargetV1;

const hostedPluginProfile = {
    profileId: 'profile_plugin_1',
    storageMode: 'plugin',
    owner: {
        kind: 'plugin',
        id: 'acme.preview',
        contributionId: 'previewPane',
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

const sessionProfile = {
    profileId: 'profile_session_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

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

const previewLaunchTarget = {
    id: 'preview:preview_vite',
    source: 'registered_preview',
    machineId: 'machine_1',
    sessionId: 'session_1',
    title: 'Vite app',
    subtitle: 'localhost:5173',
    confidence: 'high',
    state: 'available',
    actions: ['open_preview'],
    browserTarget: localPreviewTarget,
} satisfies LocalServiceLaunchTarget;

/** A running service exactly as the Services pane receives it from the canonical row model. */
const serviceRows: readonly ServiceRow[] = [{
    id: 'preview:preview_vite',
    scope: 'thisSession',
    title: 'Vite app',
    portLabel: ':5173',
    scheme: 'http',
    host: 'localhost',
    workspaceLabel: null,
    processLabel: null,
    sourceLabel: 'localServices.source.preview',
    status: 'running',
    reasonCode: null,
    primaryAction: { kind: 'open', openTarget: previewLaunchTarget },
    terminateIdentityConfidence: null,
    target: previewLaunchTarget,
    internal: false,
}];

/** The launchpad row that carries it (the model's transport for the canonical Services row). */
const serviceLaunchpadRows: readonly BrowserLaunchpadRow[] = serviceRows.map((serviceRow) => ({
    id: `service:${serviceRow.id}`,
    section: 'running',
    sourceKind: 'localService',
    title: serviceRow.title,
    detail: 'registered_preview',
    target: localPreviewTarget,
    disabledReason: null,
    lastSeenAt: 1_000,
    serviceRow,
}));

const rows: readonly BrowserLaunchpadRow[] = [...serviceLaunchpadRows, {
    id: 'recent:external_docs',
    section: 'recent',
    sourceKind: 'recent',
    title: 'Docs',
    subtitle: 'docs.happier.test',
    detail: 'externalUrl',
    target: externalTarget,
    disabledReason: null,
    lastSeenAt: 1_000,
}];

describe('BrowserLaunchpad', () => {
    it.each([false, true])('explains a failed catalog refresh and offers retry while retained rows=%s', async (retainRows) => {
        const onRefresh = vi.fn();
        const screen = await renderScreen(<BrowserLaunchpad
            rows={retainRows ? rows.filter((row) => row.section === 'recent') : []}
            platform="web"
            refreshStatus="error"
            refreshError="local_service_preview_refresh_failed"
            onRefresh={onRefresh}
        />);
        expect(screen.getTextContent()).toContain('browserLaunchpad.error.previewRefreshFailed');
        await screen.pressByTestIdAsync('browser-launchpad-error-action');
        expect(onRefresh).toHaveBeenCalledOnce();
        if (retainRows) expect(screen.findByTestId('browser-launchpad-card:recent:external_docs')).toBeTruthy();
    });
    it.each([false, true])('says once, in the shared words, that its Machine is out of reach (F-1) while retained rows=%s', async (retainRows) => {
        const machineReachability = { unreachable: true, machineName: 'Studio', lastSeenAt: null, announced: false,
            runtime: { online: false, status: 'offline' as const, label: 'Offline', nextAction: 'retry' as const, showStatus: true } };
        const screen = await renderScreen(<BrowserLaunchpad
            rows={retainRows ? rows.filter((row) => row.section === 'recent') : []}
            platform="web"
            refreshStatus="error"
            refreshError="local_service_preview_refresh_failed"
            onRefresh={vi.fn()}
            machineReachability={machineReachability}
        />);
        const text = screen.getTextContent();
        // One cause, one wording: with nothing to show, the Local services state; over retained rows, the
        // Project page's line. Never the Browser's own refresh error.
        expect(text).toContain(retainRows ? 'Offline' : 'projects.checkouts.outOfReach:{"machine":"Studio"}');
        expect(text).not.toContain('browserLaunchpad.error.title');
        expect(screen.findByTestId('browser-launchpad-error-action')).toBeNull();
        if (retainRows) expect(screen.findByTestId('browser-launchpad-card:recent:external_docs')).toBeTruthy();
    });

    it('keeps rows visible while refreshing', async () => {

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={rows}
                refreshStatus="refreshing"
                onOpenTarget={vi.fn()}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-refreshing')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-service:preview:preview_vite')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-card:recent:external_docs')).toBeTruthy();
    });

    /**
     * Lab W reconciled with lab S (services lab L): Running previews reuse the Local services row, so a
     * running service opens with the same one-tap Open it has in the Services pane.
     */
    it('opens a running service from the Services row in one tap', async () => {
        const response = previewRegistrationResponse();
        previewReceiver.mockReturnValue(response);
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={serviceLaunchpadRows}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        await screen.pressByTestIdAsync('browser-launchpad-service:preview:preview_vite-open');

        await vi.waitFor(() => expect(onOpenTarget).toHaveBeenCalledTimes(1));
        expect(onOpenTarget.mock.calls[0]?.[0]).toEqual(localPreviewTarget);
        expect(onOpenTarget.mock.calls[0]?.[1]).toMatchObject({ currentUrl: response.preview.accessUrl });
    });

    it('renews a private-preview admission when opening a recent target', async () => {
        {
            const response = previewRegistrationResponse('https://preview-vite.preview.test/?previewToken=renewed');
            previewReceiver.mockReturnValue(response);
            const onOpenTarget = vi.fn();
            const screen = await renderScreen(
                <BrowserLaunchpad platform="web" rows={[{
                    id: 'recent:preview_vite', section: 'recent', sourceKind: 'recent', title: 'Vite app',
                    detail: 'localServicePreview', target: localPreviewTarget, disabledReason: null,
                    currentUrl: 'https://preview-vite.preview.test/?previewToken=expired', currentUrlExpiresAt: 61_000, lastSeenAt: 1_000,
                }]} refreshStatus="idle" onOpenTarget={onOpenTarget} localServicePreviewServerId={serverId} />,
            );
            await screen.pressByTestIdAsync('browser-launchpad-card:recent:preview_vite');
            expect(previewReceiver).toHaveBeenCalledWith({ machineId: 'machine_1', sessionId: 'session_1', launchTargetId: 'preview_vite' }, expect.anything());
            await vi.waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith(localPreviewTarget, { platform: 'web', currentUrl: response.preview.accessUrl }));
        }
    });

    it('disables target rows when the platform adapter is unavailable', async () => {
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="web"
                rows={[{
                    id: 'recent:external_docs',
                    section: 'recent',
                    sourceKind: 'recent',
                    title: 'Docs',
                    subtitle: 'docs.happier.test',
                    detail: 'externalUrl',
                    target: externalTarget,
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:recent:external_docs-disabled')).not.toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:recent:external_docs');

        expect(onOpenTarget).not.toHaveBeenCalled();
    });

    it('fails closed for hosted-plugin targets when no browser profile policy is supplied', async () => {
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="web"
                rows={[{
                    id: 'pluginHostedWeb:preview',
                    section: 'plugin',
                    sourceKind: 'hostedPluginWeb',
                    title: 'Plugin preview',
                    subtitle: 'plugin://acme.preview/previewPane',
                    detail: 'acme.preview',
                    target: hostedPluginTarget,
                    currentUrl: 'https://plugins.happier.test/acme.preview/previewPane/',
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:pluginHostedWeb:preview-disabled')).not.toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:pluginHostedWeb:preview');

        expect(onOpenTarget).not.toHaveBeenCalled();
    });

    it('opens hosted-plugin targets when the browser profile policy matches the plugin target', async () => {
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="web"
                browserProfile={hostedPluginProfile}
                rows={[{
                    id: 'pluginHostedWeb:preview',
                    section: 'plugin',
                    sourceKind: 'hostedPluginWeb',
                    title: 'Plugin preview',
                    subtitle: 'plugin://acme.preview/previewPane',
                    detail: 'acme.preview',
                    target: hostedPluginTarget,
                    currentUrl: 'https://plugins.happier.test/acme.preview/previewPane/',
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:pluginHostedWeb:preview-disabled')).toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:pluginHostedWeb:preview');

        expect(onOpenTarget).toHaveBeenCalledWith(hostedPluginTarget, {
            platform: 'web',
            currentUrl: 'https://plugins.happier.test/acme.preview/previewPane/',
        });
    });

    it('opens desktop external URL rows only with policy and native WebView context', async () => {
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[{
                    id: 'recent:external_docs',
                    section: 'recent',
                    sourceKind: 'recent',
                    title: 'Docs',
                    subtitle: 'docs.happier.test',
                    detail: 'externalUrl',
                    target: externalTarget,
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:recent:external_docs-disabled')).toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:recent:external_docs');

        expect(onOpenTarget).toHaveBeenCalledWith(externalTarget, expect.objectContaining({
            platform: 'desktop',
            targetPolicyDecision: expect.objectContaining({
                state: 'allowed',
                profileId: 'profile_session_1',
            }),
            desktopWebViewAvailability: availableDesktopWebView,
        }));
    });

    it('honors plugin target launch and profile modes at the browser host boundary', async () => {
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();
        const pluginRow = {
            id: 'pluginExternalUrl:browserTarget:acme.preview:docs',
            section: 'plugin',
            sourceKind: 'pluginExternalUrl',
            title: 'Plugin docs',
            detail: 'acme.preview',
            target: externalTarget,
            currentUrl: externalTarget.url,
            launchMode: 'currentView',
            profileMode: 'session',
            disabledReason: null,
            lastSeenAt: 0,
        } satisfies BrowserLaunchpadRow;

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[pluginRow]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={onNavigateInPlace}
                testID="browser-launchpad"
            />,
        );

        await screen.pressByTestIdAsync(`browser-launchpad-card:${pluginRow.id}`);
        expect(onOpenTarget).not.toHaveBeenCalled();
        expect(onNavigateInPlace).toHaveBeenCalledWith(externalTarget, expect.objectContaining({
            platform: 'desktop',
            currentUrl: externalTarget.url,
        }));

        const mismatched = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[{ ...pluginRow, profileMode: 'plugin' }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={onNavigateInPlace}
                testID="browser-launchpad-mismatch"
            />,
        );
        expect(mismatched.findByTestId(`browser-launchpad-mismatch-card:${pluginRow.id}-disabled`)).not.toBeNull();
    });

    it('renders the workspace launcher (URL entry + guidance) instead of a dead banner when there are no rows', async () => {

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                testID="browser-launchpad"
            />,
        );

        // The launcher always offers an address box, even with zero detected targets.
        expect(screen.findByTestId('browser-launchpad-url-entry')).toBeTruthy();
        // Guidance replaces the dead "No browser targets" card.
        expect(screen.findByTestId('browser-launchpad-guidance')).toBeTruthy();
        // The old inert single banner is gone.
        expect(screen.findByTestId('browser-launchpad-empty')).toBeNull();
    });

    it('explains a missing managed Chromium in place of the guidance, with the code behind Details and the address field as its one action', async () => {
        const onRetry = vi.fn();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                agentBrowser={{ reasonCode: 'managed_package_missing', agent: null, onRetry }}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-url-entry')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-agent-browser')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-agent-browser-diagnostic-managed_package_missing')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-guidance')).toBeNull();
        // Chromium downloads when a page is opened, so opening an address is the way forward; a
        // re-check button beside that sentence would not say what it does.
        expect(screen.findByTestId('browser-launchpad-agent-browser-action')).toBeNull();
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('leaves the address to the host when the host already draws one', async () => {
        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                urlEntry={false}
                testID="browser-launchpad"
            />,
        );
        expect(screen.findByTestId('browser-launchpad-url-entry')).toBeNull();
        expect(screen.findByTestId('browser-launchpad-guidance')).toBeTruthy();
    });

    it('says a failed Chromium install in words, keeps the code behind Details and offers no replay (a new open is the retry)', async () => {

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                agentBrowser={{ reasonCode: 'browser_runtime_provisioning_failed', agent: null, onRetry: vi.fn() }}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-agent-browser-diagnostic-browser_runtime_provisioning_failed')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-agent-browser-action')).toBeNull();
        expect(screen.findByTestId('browser-launchpad-guidance')).toBeNull();
    });

    describe('sandbox unavailable', () => {
        async function renderSandboxCard(onAllowSandbox: () => Promise<BrowserSandboxInstallOutcome | null>) {
            return await renderScreen(
                <BrowserLaunchpad
                    platform="desktop"
                    rows={[]}
                    refreshStatus="idle"
                    onOpenTarget={vi.fn()}
                    agentBrowser={{ reasonCode: 'sandbox_unavailable', agent: null, onAllowSandbox }}
                    testID="browser-launchpad"
                />,
            );
        }
        const allowButton = 'browser-launchpad-agent-browser-allow-sandbox';

        it('offers one primary action that asks the Machine to allow the sandbox, with the code behind Details', async () => {
            const onAllowSandbox = vi.fn(async () => ({ status: 'installed' }) as const);
            const screen = await renderSandboxCard(onAllowSandbox);
            expect(screen.findByTestId('browser-launchpad-agent-browser-diagnostic-sandbox_unavailable')).toBeTruthy();
            await act(async () => { screen.pressByTestId(allowButton); });
            expect(onAllowSandbox).toHaveBeenCalledTimes(1);
            // Installed: the card says so and leaves nothing to press (the agent opens the page again).
            expect(screen.findByTestId(allowButton)).toBeNull();
            expect(screen.findByTestId('browser-launchpad-agent-browser-diagnostic-sandbox_unavailable')).toBeNull();
        });

        it('explains a missing system permission, keeps its code in Details and lets the person allow again', async () => {
            const onAllowSandbox = vi.fn(async () => ({ status: 'failed', code: 'os_authorization_required' }) as const);
            const screen = await renderSandboxCard(onAllowSandbox);
            await act(async () => { screen.pressByTestId(allowButton); });
            expect(screen.findByTestId('browser-launchpad-agent-browser-diagnostic-os_authorization_required')).toBeTruthy();
            await act(async () => { screen.pressByTestId(allowButton); });
            expect(onAllowSandbox).toHaveBeenCalledTimes(2);
        });

        it('returns to its resting card when the approval is declined', async () => {
            const onAllowSandbox = vi.fn(async () => null);
            const screen = await renderSandboxCard(onAllowSandbox);
            await act(async () => { screen.pressByTestId(allowButton); });
            expect(screen.findByTestId('browser-launchpad-agent-browser-diagnostic-sandbox_unavailable')).toBeTruthy();
            expect(screen.findByTestId(allowButton)).toBeTruthy();
        });
    });

    it('keeps the running services and recents beside the managed Chromium explanation', async () => {

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={rows}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                agentBrowser={{ reasonCode: 'managed_package_missing', agent: null }}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-agent-browser')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-service:preview:preview_vite')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-card:recent:external_docs')).toBeTruthy();
    });

    it('DV-NAV: a typed URL on the new-tab page navigates the CURRENT tab in place (onNavigateInPlace), NOT onOpenTarget', async () => {
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={onNavigateInPlace}
                testID="browser-launchpad"
            />,
        );

        screen.changeTextByTestId('browser-launchpad-url-entry', 'https://example.test');
        const input = screen.findByTestId('browser-launchpad-url-entry');
        await act(async () => {
            (input?.props as { onSubmitEditing?: () => void }).onSubmitEditing?.();
        });

        // The URL submit turns the current new-tab page INTO the page — it must NOT spawn a sibling tab.
        expect(onOpenTarget).not.toHaveBeenCalled();
        expect(onNavigateInPlace).toHaveBeenCalledTimes(1);
        const [target] = onNavigateInPlace.mock.calls[0] as [BrowserViewTargetV1, BrowserLaunchpadOpenTargetOptions | undefined];
        expect(target.kind).toBe('externalUrl');
        expect(target.kind === 'externalUrl' ? target.url : null).toBe('https://example.test/');
    });

    it('opens a running row through the canonical opener, creating BOTH a details tab AND a live content record', async () => {
        previewReceiver.mockReturnValue(previewRegistrationResponse());

        const openedTabs: DetailsTab[] = [];
        // Wire the launcher through the REAL FP-BRW-OPEN-TARGET-1 opener. The launcher only calls
        // props.onOpenTarget; the opener is the single owner of tab + content-record creation. No
        // open/dispatch path is re-implemented in the test — the opener does the work.
        const { open: onOpenTarget, dispose } = createBrowserWorkspaceOpeningFixture({
            accountLifetime: captureActiveServerAccountScopeLifetime() ?? undefined,
            scope: 'sessionDetails',
            platform: 'android',
            openDetailsTab: (tab) => {
                openedTabs.push(tab);
            },
        });

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="android"
                rows={serviceLaunchpadRows}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        await screen.pressByTestIdAsync('browser-launchpad-service:preview:preview_vite-open');
        await vi.waitFor(() => expect(openedTabs).toHaveLength(1));
        dispose();

        // (i) a canonical browser-view details-workspace tab for the target…
        expect(openedTabs).toHaveLength(1);
        expect(openedTabs[0]?.kind).toBe('browser-view');
        const tabResource = openedTabs[0]?.resource as { target?: BrowserViewTargetV1; browserSessionId?: string };
        expect(tabResource.target).toEqual(localPreviewTarget);

        // (ii) …AND a live browser content/view record under the same identity. The opener's pure
        // resolver is the authority for the seeded record; feed it the same scope/target the
        // launcher just routed and assert the content record materializes (store.openBrowserTarget).
        const resolved = resolveBrowserViewTargetOpen(
            { scope: 'sessionDetails', platform: 'android' },
            localPreviewTarget,
        );
        const viewId = resolveBrowserViewIdForTarget(localPreviewTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.target).toEqual(localPreviewTarget);
        expect(record?.browserSessionId).toBe(tabResource.browserSessionId);
    });
});
