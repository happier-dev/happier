import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

import { renderSettingsView as renderSettingsScreen } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createPluginUiResourceProjection } from '@/dev/testkit/fixtures/pluginUiResourceProjection';
import type { ImageBackgroundByKind } from '@/sync/domains/settings/registry/local/localSettingDefinitions.files';

const COMMIT_MESSAGE_RUNNER = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' } } satisfies LlmTaskRunnerConfigV1;
const HOME_IDENTITY = 'srv_source_control_target';

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
const imageBackgroundState: { value: ImageBackgroundByKind } = { value: {} };

type FilesDiffPresentationStyleValue = 'split' | 'unified' | undefined;

let filesDiffPresentationStyleValue: FilesDiffPresentationStyleValue = 'split';
let filesDiffSyntaxHighlightingModeValue: 'off' | 'simple' | 'advanced' | undefined = 'off';
let scmRemoteConfirmPolicyValue = 'always';
let scmGitRepoPreferredBackendValue: 'git' | 'sapling' = 'git';
let scmGitRepoPreferredBackendQualifiedIdValue: string | null = null;
const searchParamsState = vi.hoisted(() => ({ value: {} as Record<string, string> }));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush }),
        usePathname: () => '/settings/source-control',
        useLocalSearchParams: () => searchParamsState.value,
    }),
    storage: 'real',
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const defaultText = createTextModuleMock();
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'settingsSourceControl.backends.defaultDiffItemTitle') {
                    return `settingsSourceControl.backends.defaultDiffItemTitle:${String(params?.backendTitle ?? '')}:${String(params?.diffModeTitle ?? '')}`;
                }
                if (key === 'settingsSourceControl.commitMessageGenerator.backendItemTitle') {
                    return `settingsSourceControl.commitMessageGenerator.backendItemTitle:${String(params?.backendId ?? '')}`;
                }
                if (key === 'settingsSourceControl.page.routing.waiting') {
                    return defaultText.t(key, params);
                }
                return key;
            },
        });
    },
});

type SegmentedControlProps = Readonly<{
    tabs: ReadonlyArray<Readonly<{ id: string; label: string }>>;
    activeTabId: string;
    disabled?: boolean;
    onSelectTab: (id: string) => void;
}>;

/** The segmented control a page row carries (`SegmentedChoiceItem` renders it as the row's control). */
function segmentedControl(row: ReactTestInstance | null): SegmentedControlProps {
    const item = row?.props.rightElement ? row : row?.findAll(node => React.isValidElement(node.props.rightElement))[0];
    const control = item?.props.rightElement;
    if (!React.isValidElement<SegmentedControlProps>(control) || !Array.isArray(control.props.tabs)) {
        throw new Error('row has no segmented control');
    }
    return control.props;
}

// Home HTTP and daemon Socket RPC are the boundaries; settings, selection, projection and Actions stay real.
const { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } = await import('@/dev/testkit/harness/providerSettingsHarness');
const { createMachineFixture, createMachineMetadataFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry, readObservedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const machine = createMachineFixture({ id: 'machine-target', activeAt: Date.now(), presenceProtocolVersion: 1,
    metadata: createMachineMetadataFixture({ displayName: 'Machine Target', host: 'target.local', platform: 'linux' }) });
const rpc = createProviderSettingsHarness({ machines: [machine] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
let projection: PluginProjectionV2 | null = null;
let projectionPending = false;
let projectionFailure = false;
let accountRestored = false;

function viewSettings() {
    return settingsParse({ ...storage.getState().settings,
        'scm.diffSummary.enabled': false, 'scm.diffSummary.prefetch': false, 'scm.diffSummary.runnerV1': null,
        scmCommitStrategy: 'atomic', scmGitRepoPreferredBackend: scmGitRepoPreferredBackendValue,
        scmGitRepoPreferredBackendQualifiedId: scmGitRepoPreferredBackendQualifiedIdValue,
        scmRemoteConfirmPolicy: scmRemoteConfirmPolicyValue, scmPushRejectPolicy: 'prompt_fetch',
        scmDefaultDiffModeByBackend: {}, filesDiffSyntaxHighlightingMode: filesDiffSyntaxHighlightingModeValue,
        filesDiffRendererMode: 'pierre', filesDiffPresentationStyle: filesDiffPresentationStyleValue,
        filesChangedFilesRowDensity: 'comfortable', showLineNumbers: true, showLineNumbersInToolViews: false,
        wrapLinesInDiffs: false, scmCommitMessageGeneratorEnabled: true,
        scmCommitMessageGeneratorRunnerV1: COMMIT_MESSAGE_RUNNER, scmCommitMessageGeneratorInstructions: '',
    });
}

async function restoreViewAccount() {
    if (accountRestored) return;
    await account.restore({ currentAccount: true, serverIdentityId: HOME_IDENTITY, machines: [machine], settings: viewSettings() });
    await account.selectMachine(account.serverId, machine.id, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl);
    accountRestored = true;
}

async function primeRetainedProjection(value: PluginProjectionV2) {
    projection = value;
    await restoreViewAccount();
    await loadDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.serverId,
        accountLifetime: captureActiveServerAccountScopeLifetime(), sections: 'complete' });
    projectionPending = true;
    publishMachineContributionRegistryProjectionInvalidation({ machineId: machine.id, serverId: account.serverId }, 'authority');
}

async function renderView(element: React.ReactElement) {
    await restoreViewAccount();
    storage.getState().applyLocalSettings({ filesImageBackgroundByKind: imageBackgroundState.value });
    const screen = await renderSettingsScreen(element);
    if (!projectionPending && !projectionFailure && screen.findRowByTitle('settingsSourceControl.page.commitStrategy.title')) await vi.waitFor(() => {
        expect(readObservedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.serverId,
            accountLifetime: captureActiveServerAccountScopeLifetime() })?.kind).toBe(projection ? 'ready' : 'unsupported');
    });
    return screen;
}

afterEach(async () => {
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    await account.reset();
});

const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
const { Item } = await import('@/components/ui/lists/Item');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { AgentInputChipPickerPopover } = await import('@/components/sessions/agentInput/components/AgentInputChipPickerPopover');
const { LLM_TASK_RUNNER_AUTO_OPTION_ID } = await import('@/components/settings/llmTasks/LlmTaskRunnerPicker');

describe('SourceControlSettingsView', () => {
    it('keeps contributed resource opening available with SCM writes disabled', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'scm.writeOperations');
        try {
            const screen = await renderView(
                <AppShellPluginUiProjectionValueProvider value={{
                    pluginUiProjection: createPluginUiResourceProjection(), pluginBrowserProjection: null,
                    phase: 'current', interactionEnabled: true, machineId: 'machine-1', serverId: 'server-1', platform: 'web',
                    accountLifetime: null, clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
                }}>
                    <SourceControlSettingsView />
                </AppShellPluginUiProjectionValueProvider>,
            );
            expect(screen.findRowByTitle('sessionGitPullRequest.settings.resourceOpenTitle')).not.toBeNull();
            expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePushing.title')).toBeNull();
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it('keeps the Files editor reachable without exposing SCM-write controls when SCM writes are disabled', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'scm.writeOperations');
        try {
            const screen = await renderView(React.createElement(SourceControlSettingsView));
            expect(screen.findRowByTitle('settingsSourceControl.editorAutoSave')).not.toBeNull();
            expect(screen.findRowByTitle('settingsSourceControl.page.commitStrategy.title')).toBeNull();
            expect(screen.findRowByTitle('settingsAppearance.showLineNumbersInDiffs')).toBeNull();
            expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePushing.title')).toBeNull();
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it('writes explicit explain preferences but does not offer prefetch without an eligible selected model', async () => {
        const screen = await renderView(React.createElement(SourceControlSettingsView));
        screen.pressRowByTitle('walkthroughSettings.enabled');
        screen.pressRowByTitle('walkthroughSettings.prefetch');
        await vi.waitFor(() => expect(storage.getState().settings['scm.diffSummary.enabled']).toEqual(true));
        expect(storage.getState().settings['scm.diffSummary.prefetch']).toBe(false);
    });
    beforeEach(async () => {
        filesDiffPresentationStyleValue = 'split';
        filesDiffSyntaxHighlightingModeValue = 'off';
        scmGitRepoPreferredBackendValue = 'git';
        scmGitRepoPreferredBackendQualifiedIdValue = null;
        imageBackgroundState.value = {};
        projection = null;
        projectionPending = false;
        projectionFailure = false;
        accountRestored = false;
        rpc.reset();
        rpc.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () => {
            if (projectionPending) return new Promise<never>(() => {});
            if (projectionFailure) throw new Error('Projection read failed');
            if (!projection) throw new RpcError('Unsupported projection', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
            return { protocolVersion: 1, projection };
        });
    });

    it('reads the SCM contribution catalog from the Administration-selected exact target', async () => {
        await renderView(React.createElement(SourceControlSettingsView));

        expect(rpc.state.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            machineId: machine.id, serverId: HOME_IDENTITY,
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        })]));
    });

    it('uses the active daemon SCM projection for backend selection, settings, and hosting authentication', async () => {
        routerPush.mockClear();
        projection = PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 41,
                    // The parsed projection always carries agentsById (schema default).
                    agentsById: {},
                    installedPackagesById: {},
                    actionsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {
                        scmBackends: {
                            family: 'scmBackends',
                            entriesById: {
                                'acme.scm/stacked': {
                                    id: 'acme.scm/stacked',
                                    localId: 'stacked',
                                    pluginId: 'acme.scm',
                                    title: 'Acme Stacked SCM',
                                    description: 'Packed stacked-change backend',
                                    capabilities: ['detect', 'status', 'diff', 'commit'],
                                },
                            },
                        },
                        scmHostingProviders: {
                            family: 'scmHostingProviders',
                            entriesById: {
                                'acme.scm/forge-cloud': {
                                    id: 'acme.scm/forge-cloud',
                                    localId: 'forge-cloud',
                                    pluginId: 'acme.scm',
                                    displayName: 'Acme Forge Cloud',
                                    description: 'Authenticate the packed forge provider',
                                    authService: { pluginId: 'acme.scm', localId: 'forge-account' },
                                    capabilities: { pullRequests: { list: true, get: true, create: true } },
                                },
                                'acme.scm/forge-enterprise': {
                                    id: 'acme.scm/forge-enterprise',
                                    localId: 'forge-enterprise',
                                    pluginId: 'acme.scm',
                                    displayName: 'Acme Forge Enterprise',
                                    description: 'Authenticate the packed enterprise forge provider',
                                    authService: { pluginId: 'acme.scm', localId: 'forge-account' },
                                    capabilities: { pullRequests: { list: true, get: true, create: true } },
                                },
                            },
                        },
                        connectedAccounts: {
                            family: 'connectedAccounts',
                            entriesById: {
                                'acme.scm/forge-account': {
                                    id: 'forge-account',
                                    serviceId: 'forge-cloud',
                                    pluginId: 'acme.scm',
                                    provenance: 'external',
                                    sourceKind: 'packed',
                                    title: 'Acme Forge account',
                                    authentication: {
                                        defaultModeId: 'token',
                                        modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                                            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }],
                                    },
                                    capabilities: ['scmHostingToken'],
                                    availability: { state: 'available', reason: 'resolved' },
                                    diagnostics: [],
                                },
                            },
                        },
                    },
                    diagnostics: [],
                });

        const screen = await renderView(React.createElement(SourceControlSettingsView));

        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));
        expect(routing.tabs.map((tab) => tab.label)).toEqual(['Acme Stacked SCM']);

        // A backend with a single diff mode states it rather than offering a one-option choice.
        const defaultDiff = screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.acme.scm/stacked.defaultDiff');
        expect(defaultDiff?.props.detail).toBe('settingsSourceControl.diffMode.pending');

        expect(screen.findRowByTitle('Acme Forge Enterprise')).toBeTruthy();
        screen.pressRowByTitle('Acme Forge Enterprise');
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/[serviceId]',
            params: { serviceId: 'forge-cloud' },
        });

    });

    it('keeps a persisted legacy built-in preference selected after daemon projection qualification', async () => {
        projection = PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 42,
                    // The parsed projection always carries agentsById (schema default).
                    agentsById: {},
                    familiesById: {
                        scmBackends: {
                            family: 'scmBackends',
                            entriesById: {
                                'happier.scm.backend.git/git': {
                                    id: 'happier.scm.backend.git/git',
                                    localId: 'git',
                                    pluginId: 'happier.scm.backend.git',
                                    title: 'Git',
                                },
                            },
                        },
                        scmHostingProviders: {
                            family: 'scmHostingProviders',
                            entriesById: {},
                        },
                    },
                });

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));

        expect(routing.tabs.map((tab) => tab.label)).toEqual(['Git']);
        expect(routing.activeTabId).toBe('happier.scm.backend.git/git');
    });

    it('offers the projected built-in backend beside the qualified selection', async () => {
        scmGitRepoPreferredBackendQualifiedIdValue = 'acme.scm/stacked';
        projection = PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 43,
                    // The parsed projection always carries agentsById (schema default).
                    agentsById: {},
                    familiesById: {
                        scmBackends: {
                            family: 'scmBackends',
                            entriesById: {
                                'acme.scm/stacked': {
                                    id: 'acme.scm/stacked',
                                    localId: 'stacked',
                                    pluginId: 'acme.scm',
                                    title: 'Acme Stacked SCM',
                                },
                                'happier.scm.backend.git/git': {
                                    id: 'happier.scm.backend.git/git',
                                    localId: 'git',
                                    pluginId: 'happier.scm.backend.git',
                                    title: 'Git',
                                },
                            },
                        },
                        scmHostingProviders: {
                            family: 'scmHostingProviders',
                            entriesById: {},
                        },
                    },
                });

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));

        expect(routing.activeTabId).toBe('acme.scm/stacked');
        expect(routing.tabs.map((tab) => tab.id)).toContain('happier.scm.backend.git/git');
    });

    it.each(['loading', 'failed'] as const)('retains projected SCM metadata without claiming offline while the authoritative daemon projection is %s', async (phase) => {
        scmGitRepoPreferredBackendQualifiedIdValue = 'acme.scm/stale';
        await primeRetainedProjection(PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 40,
                    // The parsed projection always carries agentsById (schema default).
                    agentsById: {},
                    familiesById: {
                        scmBackends: {
                            family: 'scmBackends',
                            entriesById: {
                                'acme.scm/stale': {
                                    id: 'acme.scm/stale',
                                    localId: 'stale',
                                    pluginId: 'acme.scm',
                                    title: 'Acme Stale SCM',
                                },
                            },
                        },
                        scmHostingProviders: {
                            family: 'scmHostingProviders',
                            entriesById: {},
                        },
                    },
                }));

        if (phase === 'failed') {
            projectionPending = false;
            projectionFailure = true;
        }

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        if (phase === 'failed') await vi.waitFor(() => {
            expect(readObservedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.serverId,
                accountLifetime: captureActiveServerAccountScopeLifetime() })?.kind).toBe('error');
        });

        const retainedRow = screen.findAllByType(Item).find(node => node.props.title === 'settingsSourceControl.page.routing.rowTitle') ?? null;
        const retained = segmentedControl(retainedRow);
        expect(retained.tabs.map((tab) => tab.label)).toEqual(['Acme Stale SCM']);
        expect(retained.disabled).toBe(true);
        expect(retainedRow?.props.disabled).toBe(true);
        expect(retainedRow?.props.subtitle).toBe('common.unavailable');
    });

    it('says what the backend choice waits for instead of rendering an empty section', async () => {
        projectionPending = true;

        const screen = await renderView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle')).toBeNull();
        const scopeState = screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.routing.scopeState');
        expect(scopeState?.props.title).toBe('settingsSourceControl.page.routing.waiting(machine=Machine Target)');
        expect(scopeState?.props.subtitle).toBe('settingsSourceControl.page.routing.waitingDescription');
    });

    it('renders commit strategy options and updates setting when selected', async () => {
        filesDiffPresentationStyleValue = 'split';
        const screen = await renderView(React.createElement(SourceControlSettingsView));

        const strategy = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.commitStrategy.title'));
        expect(strategy.tabs.map((tab) => tab.id)).toEqual(['atomic', 'git_staging']);
        expect(strategy.activeTabId).toBe('atomic');
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));
        expect(routing.tabs.map((tab) => tab.label)).toEqual(['settingsSourceControl.page.routing.git', 'settingsSourceControl.page.routing.sapling']);
        expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePulling.title')).toBeTruthy();
        act(() => strategy.onSelectTab('git_staging'));
        await vi.waitFor(() => expect(storage.getState().settings['scmCommitStrategy']).toEqual('git_staging'));
    });

    it('defaults diff presentation style to unified when the setting is missing', async () => {
        filesDiffPresentationStyleValue = undefined;
        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const layout = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.layout'));

        expect(layout.tabs.map((tab) => tab.id)).toEqual(['unified', 'split']);
        expect(layout.activeTabId).toBe('unified');
    });

    it('marks one default-diff row when search opens it, however many backends show one', async () => {
        searchParamsState.value = { setting: 'sourceControl.backendDefaultDiff' };
        try {
            const screen = await renderView(React.createElement(SourceControlSettingsView));
            // Git and Sapling both render the row; only one carries the anchor.
            expect(screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.git.defaultDiff')).toBeTruthy();
            expect(screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.sapling.defaultDiff')).toBeTruthy();
            expect(screen.findAllByTestId('setting-reveal.sourceControl.backendDefaultDiff').filter((node) => typeof node.type === 'string')).toHaveLength(1);
        } finally {
            searchParamsState.value = {};
        }
    });

    it('only renders backend-supported default diff modes', async () => {
        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const git = await vi.waitFor(() => segmentedControl(screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.git.defaultDiff') ?? null));
        expect(git.tabs.map((tab) => tab.id)).toContain('included');
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        const sapling = screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.sapling.defaultDiff');
        expect(sapling?.props.rightElement).toBeFalsy();
        expect(sapling?.props.detail).toBe('settingsSourceControl.diffMode.pending');
    });

    it('shows the canonical highlighting default when the stored mode is unset', async () => {
        filesDiffSyntaxHighlightingModeValue = undefined;
        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.highlighting'));
        expect(control.activeTabId).toBe('advanced');
    });

    it('allows updating diff syntax highlighting mode', async () => {

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.highlighting'));
        expect(control.tabs.map((tab) => tab.id)).toContain('simple');
        act(() => control.onSelectTab('simple'));

        await vi.waitFor(() => expect(storage.getState().settings['filesDiffSyntaxHighlightingMode']).toEqual('simple'));
    });

    it('allows updating files diff renderer mode', async () => {

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.renderer'));
        expect(control.tabs.map((tab) => tab.id)).toContain('happier');
        act(() => control.onSelectTab('happier'));

        await vi.waitFor(() => expect(storage.getState().settings['filesDiffRendererMode']).toEqual('happier'));
    });

    it('allows updating diff presentation style', async () => {

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.layout'));
        expect(control.tabs.map((tab) => tab.id)).toContain('unified');
        act(() => control.onSelectTab('unified'));

        await vi.waitFor(() => expect(storage.getState().settings['filesDiffPresentationStyle']).toEqual('unified'));
    });

    it('allows updating changed files row density', async () => {

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.density'));
        expect(control.tabs.map((tab) => tab.id)).toContain('compact');
        act(() => control.onSelectTab('compact'));

        await vi.waitFor(() => expect(storage.getState().settings['filesChangedFilesRowDensity']).toEqual('compact'));
    });

    it('sets the preview background for images and SVGs together, and says when they differ', async () => {
        imageBackgroundState.value = {};
        const screen = await renderView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsAppearance.themeProfiles.groups.background'));
        expect(control.tabs.map((tab) => tab.id)).toEqual(['checkerboard', 'light', 'dark']);
        expect(control.activeTabId).toBe('checkerboard');
        act(() => control.onSelectTab('dark'));
        await vi.waitFor(() => expect(storage.getState().localSettings.filesImageBackgroundByKind).toEqual({ image: 'dark', svg: 'dark' }));

        // One kind changed from a file's ⋯ › Background: the row names both instead of picking one.
        imageBackgroundState.value = { image: 'light', svg: 'dark' };
        const mixed = await renderView(React.createElement(SourceControlSettingsView));
        expect(JSON.stringify(mixed.findRowByTitle('settingsAppearance.themeProfiles.groups.background')?.props.subtitle))
            .toContain('settingsSourceControl.page.files.imageBackgroundMixed');
    });

    it('renders code view toggles and updates their settings', async () => {

        const screen = await renderView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsAppearance.showLineNumbersInDiffs')).toBeTruthy();
        expect(screen.findRowByTitle('settingsAppearance.showLineNumbersInToolViews')).toBeTruthy();
        expect(screen.findRowByTitle('settingsAppearance.wrapLinesInDiffs')).toBeTruthy();

        screen.pressRowByTitle('settingsAppearance.showLineNumbersInDiffs');
        screen.pressRowByTitle('settingsAppearance.showLineNumbersInToolViews');
        screen.pressRowByTitle('settingsAppearance.wrapLinesInDiffs');

        await vi.waitFor(() => expect(storage.getState().settings['showLineNumbers']).toEqual(false));
        await vi.waitFor(() => expect(storage.getState().settings['showLineNumbersInToolViews']).toEqual(true));
        await vi.waitFor(() => expect(storage.getState().settings['wrapLinesInDiffs']).toEqual(true));
    });

    it('renders commit message generator settings and allows disabling', async () => {

        const screen = await renderView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.commitMessageGenerator.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.commitMessageGenerator.title');

        await vi.waitFor(() => expect(storage.getState().settings['scmCommitMessageGeneratorEnabled']).toEqual(false));
    });

    it('saves Auto choices from both background-task pickers through their setting Actions', async () => {
        const screen = await renderView(<SourceControlSettingsView />);
        const pickers = screen.findAll((node) => node.props?.task === 'scm_commit_message' && typeof node.props?.onChange === 'function');
        expect(pickers[0]?.props.value).toEqual(COMMIT_MESSAGE_RUNNER);
        const commitPicker = pickers[0]!.findAll(node => node.type === AgentInputChipPickerPopover)[0]!;
        await act(async () => { commitPicker.props.onSelect(LLM_TASK_RUNNER_AUTO_OPTION_ID); });
        await vi.waitFor(() => expect(storage.getState().settings.scmCommitMessageGeneratorRunnerV1)
            .toEqual({ v: 1, mode: 'auto', permissionMode: 'no_tools' }));
        const summaryPicker = screen.findAll(node => node.props?.task === 'scm_diff_summary' && typeof node.props?.onChange === 'function')[0]!
            .findAll(node => node.type === AgentInputChipPickerPopover)[0]!;
        await act(async () => { summaryPicker.props.onSelect(LLM_TASK_RUNNER_AUTO_OPTION_ID); });
        await vi.waitFor(() => expect(storage.getState().settings['scm.diffSummary.runnerV1'])
            .toEqual({ v: 1, mode: 'auto', permissionMode: 'read_only' }));
        // No Agent-only dropdown or free-text field remains for the commit-message runner.
        expect(screen.findAll((node) => node.props?.itemTrigger?.itemProps?.testID === 'settings.sourceControl.commitMessageAgent')).toHaveLength(0);
    });
});
