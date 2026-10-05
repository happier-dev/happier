import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
    setScmCommitStrategy,
    setExplainChanges,
    setPrepareAfterTurn,
    setScmGitRepoPreferredBackend,
    setScmRemoteConfirmPolicy,
    setScmPushRejectPolicy,
    setScmDefaultDiffModeByBackend,
    setFilesDiffSyntaxHighlightingMode,
    setFilesDiffRendererMode,
    setFilesDiffPresentationStyle,
    setFilesChangedFilesRowDensity,
    setShowLineNumbers,
    setShowLineNumbersInToolViews,
    setWrapLinesInDiffs,
    setScmCommitMessageGeneratorEnabled,
    setScmCommitMessageGeneratorBackendId,
    setScmCommitMessageGeneratorInstructions,
    applySettings,
    routerPush,
    daemonProjectionRequest,
    daemonProjectionState,
} = vi.hoisted(() => ({
    setScmCommitStrategy: vi.fn(),
    setExplainChanges: vi.fn(),
    setPrepareAfterTurn: vi.fn(),
    setScmGitRepoPreferredBackend: vi.fn(),
    setScmRemoteConfirmPolicy: vi.fn(),
    setScmPushRejectPolicy: vi.fn(),
    setScmDefaultDiffModeByBackend: vi.fn(),
    setFilesDiffSyntaxHighlightingMode: vi.fn(),
    setFilesDiffRendererMode: vi.fn(),
    setFilesDiffPresentationStyle: vi.fn(),
    setFilesChangedFilesRowDensity: vi.fn(),
    setShowLineNumbers: vi.fn(),
    setShowLineNumbersInToolViews: vi.fn(),
    setWrapLinesInDiffs: vi.fn(),
    setScmCommitMessageGeneratorEnabled: vi.fn(),
    setScmCommitMessageGeneratorBackendId: vi.fn(),
    setScmCommitMessageGeneratorInstructions: vi.fn(),
    applySettings: vi.fn(),
    routerPush: vi.fn(),
    daemonProjectionRequest: vi.fn(),
    daemonProjectionState: {
        current: {
            phase: 'unsupported',
            inputs: null,
        } as Readonly<Record<string, unknown>>,
    },
}));

type FilesDiffPresentationStyleValue = 'split' | 'unified' | undefined;

let filesDiffPresentationStyleValue: FilesDiffPresentationStyleValue = 'split';
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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: createUseSettingMutableMockFromReader((name) => {
                if (name === 'scm.diffSummary.enabled') return [false, setExplainChanges];
                if (name === 'scm.diffSummary.prefetch') return [false, setPrepareAfterTurn];
                if (name === 'scm.diffSummary.modelProfileOverride') return ['', vi.fn()];
                if (name === 'scmCommitStrategy') return ['atomic', setScmCommitStrategy];
                if (name === 'scmGitRepoPreferredBackend') return [scmGitRepoPreferredBackendValue, setScmGitRepoPreferredBackend];
                if (name === 'scmGitRepoPreferredBackendQualifiedId') return [scmGitRepoPreferredBackendQualifiedIdValue, vi.fn()];
                if (name === 'scmRemoteConfirmPolicy') return [scmRemoteConfirmPolicyValue, setScmRemoteConfirmPolicy];
                if (name === 'scmPushRejectPolicy') return ['prompt_fetch', setScmPushRejectPolicy];
                if (name === 'scmDefaultDiffModeByBackend') return [{}, setScmDefaultDiffModeByBackend];
                if (name === 'filesDiffSyntaxHighlightingMode') return ['off', setFilesDiffSyntaxHighlightingMode];
                if (name === 'filesDiffRendererMode') return ['pierre', setFilesDiffRendererMode];
                if (name === 'filesDiffPresentationStyle') return [filesDiffPresentationStyleValue, setFilesDiffPresentationStyle];
                if (name === 'filesChangedFilesRowDensity') return ['comfortable', setFilesChangedFilesRowDensity];
                if (name === 'showLineNumbers') return [true, setShowLineNumbers];
                if (name === 'showLineNumbersInToolViews') return [false, setShowLineNumbersInToolViews];
                if (name === 'wrapLinesInDiffs') return [false, setWrapLinesInDiffs];
                if (name === 'scmCommitMessageGeneratorEnabled') return [true, setScmCommitMessageGeneratorEnabled];
                if (name === 'scmCommitMessageGeneratorBackendId') return [DEFAULT_AGENT_ID, setScmCommitMessageGeneratorBackendId];
                if (name === 'scmCommitMessageGeneratorInstructions') return ['', setScmCommitMessageGeneratorInstructions];
                return [null, vi.fn()];
            }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'settingsSourceControl.backends.defaultDiffItemTitle') {
                    return `settingsSourceControl.backends.defaultDiffItemTitle:${String(params?.backendTitle ?? '')}:${String(params?.diffModeTitle ?? '')}`;
                }
                if (key === 'settingsSourceControl.commitMessageGenerator.backendItemTitle') {
                    return `settingsSourceControl.commitMessageGenerator.backendItemTitle:${String(params?.backendId ?? '')}`;
                }
                return key;
            },
        });
    },
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
    DEFAULT_AGENT_ID: 'codex',
}));

vi.mock('@/agents/registry/registryCore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/registry/registryCore')>()),
    DEFAULT_AGENT_ID: 'codex',
}));

// The segmented control is asserted through the props its row hands it.
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({ SegmentedTabBar: 'SegmentedTabBar' }));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettings,
    useAccountSettingsScope: () => ({ serverId: 'server-target', accountId: 'fixture-account' }),
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: unknown) => {
        daemonProjectionRequest(params);
        return daemonProjectionState.current;
    },
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
        candidates: [{
            target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
            displayName: 'Machine Target',
            serverLabel: 'Server Target',
            availability: 'online',
            observation: 'live',
            observedAt: 1,
        }],
        pickerRows: [],
        state: {
            kind: 'online',
            target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
            machine: {
                target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
                displayName: 'Machine Target',
                serverLabel: 'Server Target',
                availability: 'online',
                observation: 'live',
                observedAt: 1,
            },
        },
        canExecute: true,
        selectTarget: vi.fn(),
        clearTarget: vi.fn(),
        resolveExecutionTarget: () => ({
            target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
            serverId: 'server-target',
            machine: { id: 'machine-target' },
        }),
    }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement),
}));

type SegmentedControlProps = Readonly<{
    tabs: ReadonlyArray<Readonly<{ id: string; label: string }>>;
    activeTabId: string;
    disabled?: boolean;
    onSelectTab: (id: string) => void;
}>;

/** The segmented control a page row carries (`SegmentedChoiceItem` renders it as the row's control). */
function segmentedControl(row: { props: Record<string, any>; type?: unknown; findAll?: (predicate: (node: any) => boolean) => any[] } | null): SegmentedControlProps {
    // The title lookup may land on the `SegmentedChoiceItem` wrapper; its rendered row carries the control.
    const item = row && row.type !== 'Item' ? row.findAll?.((node) => node.type === 'Item')[0] ?? row : row;
    const control = item?.props.rightElement?.props as SegmentedControlProps | undefined;
    if (!control?.tabs) throw new Error('row has no segmented control');
    return control;
}

describe('SourceControlSettingsView', () => {
    it('writes explicit explain preferences but does not offer prefetch without an eligible selected model', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        screen.pressRowByTitle('walkthroughSettings.enabled');
        setPrepareAfterTurn.mockClear();
        screen.pressRowByTitle('walkthroughSettings.prefetch');
        expect(setExplainChanges).toHaveBeenCalledWith(true);
        expect(setPrepareAfterTurn).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        daemonProjectionState.current = { phase: 'unsupported', inputs: null };
        scmGitRepoPreferredBackendValue = 'git';
        scmGitRepoPreferredBackendQualifiedIdValue = null;
        applySettings.mockClear();
        daemonProjectionRequest.mockClear();
    });

    it('reads the SCM contribution catalog from the Administration-selected exact target', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        await renderSettingsView(React.createElement(SourceControlSettingsView));

        expect(daemonProjectionRequest).toHaveBeenCalledWith({
            machineId: 'machine-target',
            serverId: 'server-target',
        });
    });

    it('uses the active daemon SCM projection for backend selection, settings, and hosting authentication', async () => {
        routerPush.mockClear();
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: {
                    v: 2,
                    generation: 41,
                    installedPackagesById: {},
                    agentsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
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
                                    auth: {
                                        kind: 'manual',
                                        fields: [{ id: 'token', title: 'Token', secret: true }],
                                    },
                                    capabilities: ['scmHostingToken'],
                                    availability: { state: 'available', reason: 'resolved' },
                                    diagnostics: [],
                                },
                            },
                        },
                    },
                    diagnostics: [],
                },
            },
        };

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));
        expect(routing.tabs.map((tab) => tab.label)).toEqual(['Acme Stacked SCM']);
        act(() => routing.onSelectTab('acme.scm/stacked'));
        expect(applySettings).toHaveBeenCalledWith({
            scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
        });

        // A backend with a single diff mode states it rather than offering a one-option choice.
        const defaultDiff = screen.findRow('settings.sourceControl.backend.acme.scm/stacked.defaultDiff');
        expect(defaultDiff?.props.detail).toBe('settingsSourceControl.diffMode.pending');

        expect(screen.findRowByTitle('Acme Forge Enterprise')).toBeTruthy();
        screen.pressRowByTitle('Acme Forge Enterprise');
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/[serviceId]',
            params: { serviceId: 'forge-cloud' },
        });

    });

    it('keeps a persisted legacy built-in preference selected after daemon projection qualification', async () => {
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: {
                    v: 2,
                    generation: 42,
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
                },
            },
        };

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));

        expect(routing.tabs.map((tab) => tab.label)).toEqual(['Git']);
        expect(routing.activeTabId).toBe('happier.scm.backend.git/git');
    });

    it('clears a qualified selection atomically when selecting a projected built-in backend', async () => {
        scmGitRepoPreferredBackendQualifiedIdValue = 'acme.scm/stacked';
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: {
                    v: 2,
                    generation: 43,
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
                },
            },
        };

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));

        expect(routing.activeTabId).toBe('acme.scm/stacked');
        act(() => routing.onSelectTab('happier.scm.backend.git/git'));
        expect(applySettings).toHaveBeenCalledWith({
            scmGitRepoPreferredBackend: 'git',
            scmGitRepoPreferredBackendQualifiedId: null,
        });
    });

    it('retains projected SCM metadata read-only while the authoritative daemon projection is loading', async () => {
        daemonProjectionState.current = {
            phase: 'loading',
            inputs: {
                pluginProjectionV2: {
                    v: 2,
                    generation: 40,
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
                },
            },
        };

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        const retainedRow = screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle');
        const retained = segmentedControl(retainedRow);
        expect(retained.tabs.map((tab) => tab.label)).toEqual(['Acme Stale SCM']);
        expect(retained.disabled).toBe(true);
        expect(retainedRow?.props.disabled).toBe(true);
    });

    it('says what the backend choice waits for instead of rendering an empty section', async () => {
        daemonProjectionState.current = { phase: 'loading', inputs: null };

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle')).toBeNull();
        const scopeState = screen.findRow('settings.sourceControl.routing.scopeState');
        expect(scopeState?.props.title).toBe('settingsSourceControl.page.routing.waiting');
        expect(scopeState?.props.subtitle).toBe('settingsSourceControl.page.routing.waitingDescription');
    });

    it('renders commit strategy options and updates setting when selected', async () => {
        filesDiffPresentationStyleValue = 'split';
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        const strategy = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.commitStrategy.title'));
        expect(strategy.tabs.map((tab) => tab.id)).toEqual(['atomic', 'git_staging']);
        expect(strategy.activeTabId).toBe('atomic');
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));
        expect(routing.tabs.map((tab) => tab.label)).toEqual(['settingsSourceControl.page.routing.git', 'settingsSourceControl.page.routing.sapling']);
        expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePulling.title')).toBeTruthy();
        act(() => strategy.onSelectTab('git_staging'));
        expect(setScmCommitStrategy).toHaveBeenCalledWith('git_staging');
    });

    it('maps remote pull and push confirmation switches to the persisted policy enum', async () => {
        scmRemoteConfirmPolicyValue = 'always';
        setScmRemoteConfirmPolicy.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        screen.pressRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePulling.title');
        expect(setScmRemoteConfirmPolicy).toHaveBeenCalledWith('push_only');

        setScmRemoteConfirmPolicy.mockClear();
        screen.pressRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePushing.title');
        expect(setScmRemoteConfirmPolicy).toHaveBeenCalledWith('pull_only');
    });

    it('defaults diff presentation style to unified when the setting is missing', async () => {
        filesDiffPresentationStyleValue = undefined;
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const layout = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.layout'));

        expect(layout.tabs.map((tab) => tab.id)).toEqual(['unified', 'split']);
        expect(layout.activeTabId).toBe('unified');
    });

    it('marks one default-diff row when search opens it, however many backends show one', async () => {
        searchParamsState.value = { setting: 'sourceControl.backendDefaultDiff' };
        try {
            const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
            const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
            // Git and Sapling both render the row; only one carries the anchor.
            expect(screen.findRow('settings.sourceControl.backend.git.defaultDiff')).toBeTruthy();
            expect(screen.findRow('settings.sourceControl.backend.sapling.defaultDiff')).toBeTruthy();
            expect(screen.findAllByTestId('setting-reveal.sourceControl.backendDefaultDiff').filter((node) => typeof node.type === 'string')).toHaveLength(1);
        } finally {
            searchParamsState.value = {};
        }
    });

    it('only renders backend-supported default diff modes', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const git = segmentedControl(screen.findRow('settings.sourceControl.backend.git.defaultDiff'));
        expect(git.tabs.map((tab) => tab.id)).toContain('included');
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        const sapling = screen.findRow('settings.sourceControl.backend.sapling.defaultDiff');
        expect(sapling?.props.rightElement).toBeFalsy();
        expect(sapling?.props.detail).toBe('settingsSourceControl.diffMode.pending');
    });

    it('allows updating diff syntax highlighting mode', async () => {
        setFilesDiffSyntaxHighlightingMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.highlighting'));
        expect(control.tabs.map((tab) => tab.id)).toContain('simple');
        act(() => control.onSelectTab('simple'));

        expect(setFilesDiffSyntaxHighlightingMode).toHaveBeenCalledWith('simple');
    });

    it('allows updating files diff renderer mode', async () => {
        setFilesDiffRendererMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.renderer'));
        expect(control.tabs.map((tab) => tab.id)).toContain('happier');
        act(() => control.onSelectTab('happier'));

        expect(setFilesDiffRendererMode).toHaveBeenCalledWith('happier');
    });

    it('allows updating diff presentation style', async () => {
        setFilesDiffPresentationStyle.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.layout'));
        expect(control.tabs.map((tab) => tab.id)).toContain('unified');
        act(() => control.onSelectTab('unified'));

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('unified');
    });

    it('allows updating changed files row density', async () => {
        setFilesChangedFilesRowDensity.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.density'));
        expect(control.tabs.map((tab) => tab.id)).toContain('compact');
        act(() => control.onSelectTab('compact'));

        expect(setFilesChangedFilesRowDensity).toHaveBeenCalledWith('compact');
    });

    it('renders code view toggles and updates their settings', async () => {
        setShowLineNumbers.mockClear();
        setShowLineNumbersInToolViews.mockClear();
        setWrapLinesInDiffs.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsAppearance.showLineNumbersInDiffs')).toBeTruthy();
        expect(screen.findRowByTitle('settingsAppearance.showLineNumbersInToolViews')).toBeTruthy();
        expect(screen.findRowByTitle('settingsAppearance.wrapLinesInDiffs')).toBeTruthy();

        screen.pressRowByTitle('settingsAppearance.showLineNumbersInDiffs');
        screen.pressRowByTitle('settingsAppearance.showLineNumbersInToolViews');
        screen.pressRowByTitle('settingsAppearance.wrapLinesInDiffs');

        expect(setShowLineNumbers).toHaveBeenCalledWith(false);
        expect(setShowLineNumbersInToolViews).toHaveBeenCalledWith(true);
        expect(setWrapLinesInDiffs).toHaveBeenCalledWith(true);
    });

    it('renders commit message generator settings and allows disabling', async () => {
        setScmCommitMessageGeneratorEnabled.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.commitMessageGenerator.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.commitMessageGenerator.title');

        expect(setScmCommitMessageGeneratorEnabled).toHaveBeenCalledWith(false);
    });

    it('allows editing commit message generator instructions', async () => {
        setScmCommitMessageGeneratorInstructions.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const instructions = screen.findRowByTitle('settingsSourceControl.page.generator.instructionsTitle')?.props.rightElement;
        expect(instructions?.props.placeholder).toBe('settingsSourceControl.commitMessageGenerator.instructionsPlaceholder');

        await act(async () => {
            instructions!.props.onChangeText?.('Use imperative mood');
        });

        expect(setScmCommitMessageGeneratorInstructions).toHaveBeenCalledWith('Use imperative mood');
    });

    it('commits a trimmed inline agent draft on submit and ignores an empty draft', async () => {
        setScmCommitMessageGeneratorBackendId.mockClear();
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(<SourceControlSettingsView />);
        expect(screen.findByTestId('settings.sourceControl.commitMessageAgent')).toBeTruthy();
        act(() => screen.changeTextByTestId('settings.sourceControl.commitMessageAgent', ' custom-agent '));
        expect(setScmCommitMessageGeneratorBackendId).not.toHaveBeenCalled();
        act(() => screen.findByTestId('settings.sourceControl.commitMessageAgent')!.props.onSubmitEditing());
        expect(setScmCommitMessageGeneratorBackendId).toHaveBeenCalledWith('custom-agent');
        setScmCommitMessageGeneratorBackendId.mockClear();
        act(() => screen.changeTextByTestId('settings.sourceControl.commitMessageAgent', ' '));
        act(() => screen.findByTestId('settings.sourceControl.commitMessageAgent')!.props.onBlur());
        expect(setScmCommitMessageGeneratorBackendId).not.toHaveBeenCalled();
    });
});
