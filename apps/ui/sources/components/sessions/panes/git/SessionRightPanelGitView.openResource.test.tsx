import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { ScmPullRequestSummarySchema } from '@happier-dev/protocol/scm/pullRequests';
import { SessionInputForgeEvidenceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { normalizePluginUiDestinationBindingV1, normalizePluginUiInlineSurfaceBindingV1, PluginUiSurfaceBindingV1Schema } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, createThemeFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createPluginDetailsDestinationLaunchStore, createPluginDetailsDestinationNavigationOwners } from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';
import { createPluginSurfaceDestinationNavigationBinding, PluginSurfaceDestinationNavigationBindingProvider, useRegisterPluginSurfaceDestinationNavigationOwner } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { PluginPageLaunchInputScope, usePluginPageDestinationHandler } from '@/components/plugins/pages/pluginPageNavigation';
import { selectPluginPagePlacements, usePluginPages } from '@/components/plugins/pages/pluginPages';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installSessionDetailsPanelNonRnModuleMocks } from '../sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '../sessionPaneRuntimeTestHarness';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Linking: { openURL: async () => { throw new Error('No native opener in this web client'); } } });
});
installSessionDetailsPanelNonRnModuleMocks({ router: false });

const pullRequest = ScmPullRequestSummarySchema.parse({
    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', repositoryWebUrl: 'https://github.com/acme/repo', nameWithOwner: 'acme/repo' },
    number: 42, url: 'https://github.com/acme/repo/pull/42', title: 'Exact resource',
    headBranch: 'topic', baseBranch: 'main', state: 'open',
});
let snapshot: ScmWorkingSnapshot;
const runtime = installSessionPaneRuntimeTestHarness({ credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) }, rpc: async (method) => {
    if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot };
    if (method === RPC_METHODS.SCM_LOG_LIST) return { success: true, entries: [] };
    if (method === RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE) return { success: true, reused: false, pullRequest, nextAction: { kind: 'none' } };
    return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
} });
let unpublish: (() => void) | undefined;
const externalOpen = vi.fn();
beforeEach(() => {
    vi.stubGlobal('open', externalOpen);
    externalOpen.mockClear();
    snapshot = {
        fetchedAt: Date.now(), projectKey: 'm1:/repo',
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [], worktrees: [] },
        capabilities: createScmCapabilities({ readStatus: true, readLog: true, writePullRequestCreate: true }),
        hostingProvider: pullRequest.provider,
        branch: { head: 'topic', upstream: 'origin/topic', ahead: 0, behind: 0, detached: false },
        stashCount: 0, hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        pullRequestStatus: { provider: pullRequest.provider, headBranch: 'topic', baseBranch: 'main', authState: 'authenticated', checkedAt: Date.now(), openPullRequest: pullRequest },
    };
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true,
        metadata: { machineId: 'm1', path: '/repo', host: 'test-machine' } })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    storage.getState().applySettingsLocal({ scmGitPaneLayout: 'tabs', scmResourceOpenLocation: 'happier', experiments: true, featureToggles: { 'scm.writeOperations': true } });
    storage.getState().updateSessionProjectScmSnapshot('s1', snapshot, runtime.serverId);
});
afterEach(() => { unpublish?.(); unpublish = undefined; vi.unstubAllGlobals(); });

function AppResourceNavigationOwner({ projection }: Readonly<{ projection: PluginUiProjectionModel }>) {
    const pages = usePluginPages({ target: { kind: 'app' }, placements: selectPluginPagePlacements(projection, { container: 'appPage', targetKind: 'app' }) });
    const handler = usePluginPageDestinationHandler({ pages });
    const owner = React.useMemo(() => ({ container: 'appPage' as const, handler }), [handler]);
    useRegisterPluginSurfaceDestinationNavigationOwner(owner);
    return null;
}

function ResourceDestinationHost({ children, targetKind = 'session', available = true }: React.PropsWithChildren<{ targetKind?: 'session' | 'app'; available?: boolean }>) {
    const projection = React.useMemo(() => {
        const pluginId = 'acme.resources';
        const inline = normalizePluginUiInlineSurfaceBindingV1({ pluginId, surfaceId: 'pr', rendererId: 'card', role: 'scmPullRequest', target: { kind: targetKind } });
        const details = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'resource-details', rendererId: 'detail',
            container: targetKind === 'app' ? 'appPage' : 'detailsTab', target: { kind: targetKind },
            instancePolicy: targetKind === 'app' ? 'singleton' : 'multiple' });
        if (!inline || !details) throw new Error('Expected admitted fixture bindings');
        const hostOrigin = { machineId: 'm1', serverId: runtime.serverId, phase: 'current', interactionEnabled: true,
            executionOrigin: { serverIdentityId: runtime.serverIdentityId, materializationRef: { pluginId, machineId: 'm1', materializationId: 'resources-install' } } };
        const common = { pluginId, occurrenceId: 'resource-occurrence', contributionKind: 'surfacePlacement',
            availability: { state: 'available', reason: 'available', diagnostics: [] }, hostOrigin };
        return normalizePluginUiProjection({ v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                scm: { ...common, id: 'scm', descriptorId: 'pr', binding: PluginUiSurfaceBindingV1Schema.parse(inline), target: inline.target, renderer: { kind: 'declarative', contributionId: 'card' }, display: { title: 'Pull request' },
                    resourceLinks: [
                        { kind: 'pullRequest', urlPattern: '^https://github\\.com/[^/]+/[^/]+/pull/[0-9]+$', destination: 'resource-details' },
                        { kind: 'issue', urlPattern: '^https://github\\.com/[^/]+/[^/]+/issues/[0-9]+$', destination: 'resource-details' },
                        { kind: 'ciRun', urlPattern: '^https://github\\.com/[^/]+/[^/]+/actions/runs/[0-9]+$', destination: 'resource-details' },
                        { kind: 'securityAlert', urlPattern: '^https://github\\.com/[^/]+/[^/]+/security/dependabot/[0-9]+$', destination: 'resource-details' },
                    ] },
                details: { ...common, id: 'details', descriptorId: 'resource-details', binding: PluginUiSurfaceBindingV1Schema.parse(details), target: details.target, renderer: { kind: 'declarative', contributionId: 'detail' }, display: { title: 'Resource' } },
            } } } });
    }, [targetKind]);
    React.useLayoutEffect(() => {
        // The committed app catalog does not contain the Session's Machine-scoped declarations.
        const appProjection = { ...projection, surfacePlacementsById: Object.fromEntries(Object.entries(projection.surfacePlacementsById)
            .filter(([, placement]) => placement.binding.targetKind === 'app')) };
        unpublish = publishCommittedAppShellPluginUiProjection(() => available ? appProjection : null);
        return unpublish;
    }, [projection, available]);
    const binding = React.useMemo(() => {
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const nav = createPluginSurfaceDestinationNavigationBinding({ placements: selectPluginDestinationSurfacePlacements(projection), projection: available ? projection : null, targetKind, accountLifetime,
            scopedLaunchFacts: { serverId: runtime.serverId, machineId: 'm1', interactionEnabled: true } });
        if (targetKind === 'app') return nav;
        const owners = createPluginDetailsDestinationNavigationOwners({ store: createPluginDetailsDestinationLaunchStore(), accountLifetime,
            targetKind: 'session', projection, mount: { sessionId: 's1', serverId: runtime.serverId, machineId: 'm1', platform: 'web', projectionPhase: 'current', projectionInteractionEnabled: true },
            openTab: tab => runtime.pane.openDetailsTab(tab, { intent: 'pinned' }) });
        nav.registerOwner({ container: 'detailsTab', handler: owners.detailsTab });
        return nav;
    }, [available, projection, targetKind]);
    return <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>
        {targetKind === 'app' ? <PluginPageLaunchInputScope target={{ kind: 'app' }} pluginUiProjection={projection}>
            <AppResourceNavigationOwner projection={projection} />{children}
        </PluginPageLaunchInputScope> : children}
    </PluginSurfaceDestinationNavigationBindingProvider>;
}

async function renderEntry(entry: 'header' | 'card' | 'created', available = true) {
    const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
    const { GitPullRequestSection } = await import('./pullRequest/GitPullRequestSection');
    const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
    if (entry === 'created') {
        const { createSessionGitPullRequest } = await import('./pullRequest/createSessionGitPullRequest');
        const created = await createSessionGitPullRequest({ state: storage.getState(), sessionId: 's1', serverId: runtime.serverId, machineReachable: true, draftSupported: true,
            request: { base: 'main', head: 'topic', title: 'Exact resource', body: '', draft: false } });
        expect(created).toMatchObject({ kind: 'created', pullRequest });
    }
    function Header() { const header = usePublishedPaneHeaderContent('git'); return <>{header?.action}</>; }
    return renderScreen(<runtime.Wrapper><ResourceDestinationHost available={available}>
        {entry === 'header' ? <PaneHeaderSlotProvider><Header /><PaneHeaderSlotScope slotKey="git"><SessionRightPanelGitView sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" /></PaneHeaderSlotScope></PaneHeaderSlotProvider>
            : <GitPullRequestSection sessionId="s1" serverId={runtime.serverId} scopeId="session:s1" snapshot={snapshot} machineReachable />}
    </ResourceDestinationHost></runtime.Wrapper>);
}

describe('Session Git opens resources through the host decision', () => {
    it.each(['header', 'card', 'created'] as const)('opens the exact PR as a pinned details tab from %s', async entry => {
        const screen = await renderEntry(entry);
        await screen.pressByTestIdAsync(entry === 'header' ? 'session-git-header-action:open-pr' : 'git-pull-request-card-open');
        await act(async () => { await Promise.resolve(); });
        expect(runtime.pane.scopeState?.details.tabs).toEqual([expect.objectContaining({
            kind: 'pluginDetailsDestination', resource: { kind: 'pluginDetailsDestination', destination: { pluginId: 'acme.resources', localId: 'resource-details' }, instanceKey: pullRequest.url },
            isPreview: false,
        })]);
        expect(externalOpen).not.toHaveBeenCalled();
    });

    it('opens an existing Project Git PR through the same resource owner', async () => {
        const { SourceControlPullRequestSection } = await import('@/components/workspaces/scm/update/SourceControlPullRequestSection');
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        const screen = await renderScreen(<runtime.Wrapper><ResourceDestinationHost targetKind="app">
            <SourceControlPullRequestSection theme={createThemeFixture()} snapshot={snapshot}
                onOpenOrReuse={vi.fn()} onRefresh={vi.fn(async () => {})} />
        </ResourceDestinationHost></runtime.Wrapper>);
        await screen.pressByTestIdAsync('scm-pull-request-primary');
        await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/plugins/acme.resources/resource-details'));
        expect(externalOpen).not.toHaveBeenCalled();
    });

    it.each(['header', 'card', 'created'] as const)('honors the GitHub preference from %s', async entry => {
        const screen = await renderEntry(entry);
        storage.getState().applySettingsLocal({ scmResourceOpenLocation: 'github' });
        expect(storage.getState().settings.scmResourceOpenLocation).toBe('github');
        await screen.pressByTestIdAsync(entry === 'header' ? 'session-git-header-action:open-pr' : 'git-pull-request-card-open');
        await vi.waitFor(() => expect(externalOpen).toHaveBeenCalledWith(pullRequest.url, '_blank', 'noopener,noreferrer'));
        expect(runtime.pane.scopeState?.details.tabs ?? []).toEqual([]);
    });

    it.each(['header', 'card', 'created'] as const)('opens externally without an available contributor from %s', async entry => {
        const screen = await renderEntry(entry, false);
        await screen.pressByTestIdAsync(entry === 'header' ? 'session-git-header-action:open-pr' : 'git-pull-request-card-open');
        await vi.waitFor(() => expect(externalOpen).toHaveBeenCalledWith(pullRequest.url, '_blank', 'noopener,noreferrer'));
        expect(runtime.pane.scopeState?.details.tabs ?? []).toEqual([]);
    });
});

function expectResourceTab(url: string) {
    expect(runtime.pane.scopeState?.details.tabs).toEqual([expect.objectContaining({
        kind: 'pluginDetailsDestination', resource: { kind: 'pluginDetailsDestination',
            destination: { pluginId: 'acme.resources', localId: 'resource-details' }, instanceKey: url },
        isPreview: false,
    })]);
    expect(externalOpen).not.toHaveBeenCalled();
}

describe('Markdown resource entry points', () => {
    it.each(['prose', 'table'] as const)('opens a resource from %s through the same details destination', async variant => {
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        const url = 'https://github.com/acme/repo/issues/17';
        const markdown = variant === 'prose' ? `[Issue](${url})` : `| Resource |\n| --- |\n| [Issue](${url}) |`;
        const screen = await renderScreen(<runtime.Wrapper><ResourceDestinationHost>
            <MarkdownView markdown={markdown} />
        </ResourceDestinationHost></runtime.Wrapper>);
        await act(async () => {
            if (variant === 'prose') screen.findByType('EnrichedMarkdownText').props.onLinkPress({ url });
            else {
                const link = screen.tree.root.findAll(node => node.props.href === url || node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function').at(-1);
                if (!link) throw new Error('Rendered table resource link missing');
                link.props.onPress?.();
            }
        });
        expectResourceTab(url);
    });

    it('lets a custom link owner consume a recognized URL before resource navigation', async () => {
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        const onLinkPress = vi.fn(() => true);
        const screen = await renderScreen(<runtime.Wrapper><ResourceDestinationHost>
            <MarkdownView markdown={`[PR](${pullRequest.url})`} onLinkPress={onLinkPress} />
        </ResourceDestinationHost></runtime.Wrapper>);
        await act(async () => { screen.findByType('EnrichedMarkdownText').props.onLinkPress({ url: pullRequest.url }); });
        expect(onLinkPress).toHaveBeenCalledWith(pullRequest.url);
        expect(runtime.pane.scopeState?.details.tabs ?? []).toEqual([]);
        expect(externalOpen).not.toHaveBeenCalled();
    });
});

describe('Inbox notification resource entry', () => {
    it('opens the exact Landing PR through the app page owner and keeps the pre-navigation callback', async () => {
        const { InboxWorkItemRow } = await import('@/components/inbox/workGroups/InboxWorkItemRow');
        const session = createSessionFixture({ id: 's1', serverId: runtime.serverId });
        const item = { kind: 'landing', key: 'landing:s1', session,
            link: { sessionId: session.id, serverId: runtime.serverId, number: 42, url: pullRequest.url, state: 'open', observedAt: 100 } } as const;
        const beforeNavigate = vi.fn();
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        const screen = await renderScreen(<runtime.Wrapper><ResourceDestinationHost targetKind="app">
            <InboxWorkItemRow item={item} spansHomes={false} workflowServerId={runtime.serverId} identityDisplay="none"
                presentation="screen" navigate={vi.fn()} onBeforeNavigate={beforeNavigate} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />
        </ResourceDestinationHost></runtime.Wrapper>);
        await screen.pressByTestIdAsync('inbox.landing.s1');
        await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/plugins/acme.resources/resource-details'));
        expect(externalOpen).not.toHaveBeenCalled();
        expect(beforeNavigate).toHaveBeenCalledOnce();
    });
});

describe('Hosted forge resource entry', () => {
    it.each([
        { kind: 'hostedCi', url: 'https://github.com/acme/repo/actions/runs/123' },
        { kind: 'pullRequest', url: pullRequest.url },
        { kind: 'alert', url: 'https://github.com/acme/repo/security/dependabot/9' },
    ] as const)('opens $kind evidence through the same resource details owner', async source => {
        const { ForgeEvidenceInputCard } = await import('@/components/sessions/transcript/forgeEvidence/ForgeEvidenceInputCard');
        const evidence = SessionInputForgeEvidenceV1Schema.parse({ v: 1, items: [
            { source: { ...source, label: 'Resource' }, author: { kind: 'bot' }, text: 'Review the evidence' },
        ] });
        const screen = await renderScreen(<runtime.Wrapper><ResourceDestinationHost>
            <ForgeEvidenceInputCard evidence={evidence} testID="forge-resource" />
        </ResourceDestinationHost></runtime.Wrapper>);
        const link = screen.tree.root.findAll(node => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function').at(-1);
        if (!link) throw new Error('Rendered evidence resource link missing');
        await act(async () => { link.props.onPress(); });
        expectResourceTab(source.url);
    });
});
