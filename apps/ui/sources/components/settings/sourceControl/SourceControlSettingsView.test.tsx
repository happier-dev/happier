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
    routerPush,
    daemonProjectionRequest,
    daemonProjectionState,
    setFilesImageBackgroundByKind,
    imageBackgroundState,
} = vi.hoisted(() => ({
    setFilesImageBackgroundByKind: vi.fn(),
    imageBackgroundState: { value: {} as Readonly<Record<string, string>> },
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
                if (name === 'filesDiffSyntaxHighlightingMode') return [filesDiffSyntaxHighlightingModeValue, setFilesDiffSyntaxHighlightingMode];
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
            useLocalSettingMutable: ((name: string) => name === 'filesImageBackgroundByKind'
                ? [imageBackgroundState.value, setFilesImageBackgroundByKind] : [undefined, vi.fn()]) as never,
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




type SegmentedControlProps = Readonly<{
    tabs: ReadonlyArray<Readonly<{ id: string; label: string }>>;
    activeTabId: string;
    disabled?: boolean;
    onSelectTab: (id: string) => void;
}>;

/** The segmented control a page row carries (`SegmentedChoiceItem` renders it as the row's control). */
function segmentedControl(row: { props: Record<string, any>; type?: unknown; findAll?: (predicate: (node: any) => boolean) => any[] } | null): SegmentedControlProps {
    // The title lookup may land on the `SegmentedChoiceItem` wrapper; its rendered row carries the control.
    const item = row?.props.rightElement ? row : row?.findAll?.((node) => node.props.rightElement?.props?.tabs)[0] ?? row;
    const control = item?.props.rightElement?.props as SegmentedControlProps | undefined;
    if (!control?.tabs) throw new Error('row has no segmented control');
    return control;
}

// Load real screen owners after boundary setup, outside behavior deadlines.
const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
const { Item } = await import('@/components/ui/lists/Item');

describe('SourceControlSettingsView', () => {
    it('keeps the Files editor reachable without exposing SCM-write controls when SCM writes are disabled', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'scm.writeOperations');
        try {
            const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
            expect(screen.findRowByTitle('settingsSourceControl.editorAutoSave')).not.toBeNull();
            expect(screen.findRowByTitle('settingsSourceControl.page.commitStrategy.title')).toBeNull();
            expect(screen.findRowByTitle('settingsAppearance.showLineNumbersInDiffs')).toBeNull();
            expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePushing.title')).toBeNull();
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it('writes explicit explain preferences but does not offer prefetch without an eligible selected model', async () => {
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        screen.pressRowByTitle('walkthroughSettings.enabled');
        setPrepareAfterTurn.mockClear();
        screen.pressRowByTitle('walkthroughSettings.prefetch');
        expect(setExplainChanges).toHaveBeenCalledWith(true);
        expect(setPrepareAfterTurn).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        filesDiffSyntaxHighlightingModeValue = 'off';
        daemonProjectionState.current = { phase: 'unsupported', inputs: null };
        scmGitRepoPreferredBackendValue = 'git';
        scmGitRepoPreferredBackendQualifiedIdValue = null;
        daemonProjectionRequest.mockClear();
    });

    it('reads the SCM contribution catalog from the Administration-selected exact target', async () => {
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

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

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

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));

        expect(routing.tabs.map((tab) => tab.label)).toEqual(['Git']);
        expect(routing.activeTabId).toBe('happier.scm.backend.git/git');
    });

    it('offers the projected built-in backend beside the qualified selection', async () => {
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

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const routing = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle'));

        expect(routing.activeTabId).toBe('acme.scm/stacked');
        expect(routing.tabs.map((tab) => tab.id)).toContain('happier.scm.backend.git/git');
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

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        const retainedRow = screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle');
        const retained = segmentedControl(retainedRow);
        expect(retained.tabs.map((tab) => tab.label)).toEqual(['Acme Stale SCM']);
        expect(retained.disabled).toBe(true);
        expect(retainedRow?.props.disabled).toBe(true);
    });

    it('says what the backend choice waits for instead of rendering an empty section', async () => {
        daemonProjectionState.current = { phase: 'loading', inputs: null };

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsSourceControl.page.routing.rowTitle')).toBeNull();
        const scopeState = screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.routing.scopeState');
        expect(scopeState?.props.title).toBe('settingsSourceControl.page.routing.waiting');
        expect(scopeState?.props.subtitle).toBe('settingsSourceControl.page.routing.waitingDescription');
    });

    it('renders commit strategy options and updates setting when selected', async () => {
        filesDiffPresentationStyleValue = 'split';
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

    it('defaults diff presentation style to unified when the setting is missing', async () => {
        filesDiffPresentationStyleValue = undefined;
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const layout = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.layout'));

        expect(layout.tabs.map((tab) => tab.id)).toEqual(['unified', 'split']);
        expect(layout.activeTabId).toBe('unified');
    });

    it('marks one default-diff row when search opens it, however many backends show one', async () => {
        searchParamsState.value = { setting: 'sourceControl.backendDefaultDiff' };
        try {
            const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
            // Git and Sapling both render the row; only one carries the anchor.
            expect(screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.git.defaultDiff')).toBeTruthy();
            expect(screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.sapling.defaultDiff')).toBeTruthy();
            expect(screen.findAllByTestId('setting-reveal.sourceControl.backendDefaultDiff').filter((node) => typeof node.type === 'string')).toHaveLength(1);
        } finally {
            searchParamsState.value = {};
        }
    });

    it('only renders backend-supported default diff modes', async () => {
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const git = segmentedControl(screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.git.defaultDiff') ?? null);
        expect(git.tabs.map((tab) => tab.id)).toContain('included');
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        const sapling = screen.findAllByType(Item).find(node => node.props.testID === 'settings.sourceControl.backend.sapling.defaultDiff');
        expect(sapling?.props.rightElement).toBeFalsy();
        expect(sapling?.props.detail).toBe('settingsSourceControl.diffMode.pending');
    });

    it('shows the canonical highlighting default when the stored mode is unset', async () => {
        filesDiffSyntaxHighlightingModeValue = undefined;
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.highlighting'));
        expect(control.activeTabId).toBe('advanced');
    });

    it('allows updating diff syntax highlighting mode', async () => {
        setFilesDiffSyntaxHighlightingMode.mockClear();

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.highlighting'));
        expect(control.tabs.map((tab) => tab.id)).toContain('simple');
        act(() => control.onSelectTab('simple'));

        expect(setFilesDiffSyntaxHighlightingMode).toHaveBeenCalledWith('simple');
    });

    it('allows updating files diff renderer mode', async () => {
        setFilesDiffRendererMode.mockClear();

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.renderer'));
        expect(control.tabs.map((tab) => tab.id)).toContain('happier');
        act(() => control.onSelectTab('happier'));

        expect(setFilesDiffRendererMode).toHaveBeenCalledWith('happier');
    });

    it('allows updating diff presentation style', async () => {
        setFilesDiffPresentationStyle.mockClear();

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.layout'));
        expect(control.tabs.map((tab) => tab.id)).toContain('unified');
        act(() => control.onSelectTab('unified'));

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('unified');
    });

    it('allows updating changed files row density', async () => {
        setFilesChangedFilesRowDensity.mockClear();

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsSourceControl.page.files.density'));
        expect(control.tabs.map((tab) => tab.id)).toContain('compact');
        act(() => control.onSelectTab('compact'));

        expect(setFilesChangedFilesRowDensity).toHaveBeenCalledWith('compact');
    });

    it('sets the preview background for images and SVGs together, and says when they differ', async () => {
        setFilesImageBackgroundByKind.mockClear();
        imageBackgroundState.value = {};
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const control = segmentedControl(screen.findRowByTitle('settingsAppearance.themeProfiles.groups.background'));
        expect(control.tabs.map((tab) => tab.id)).toEqual(['checkerboard', 'light', 'dark']);
        expect(control.activeTabId).toBe('checkerboard');
        act(() => control.onSelectTab('dark'));
        expect(setFilesImageBackgroundByKind).toHaveBeenCalledWith({ image: 'dark', svg: 'dark' });

        // One kind changed from a file's ⋯ › Background: the row names both instead of picking one.
        imageBackgroundState.value = { image: 'light', svg: 'dark' };
        const mixed = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(JSON.stringify(mixed.findRowByTitle('settingsAppearance.themeProfiles.groups.background')?.props.subtitle))
            .toContain('settingsSourceControl.page.files.imageBackgroundMixed');
    });

    it('renders code view toggles and updates their settings', async () => {
        setShowLineNumbers.mockClear();
        setShowLineNumbersInToolViews.mockClear();
        setWrapLinesInDiffs.mockClear();

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

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.commitMessageGenerator.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.commitMessageGenerator.title');

        expect(setScmCommitMessageGeneratorEnabled).toHaveBeenCalledWith(false);
    });

    it('allows editing commit message generator instructions', async () => {
        setScmCommitMessageGeneratorInstructions.mockClear();

        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        const instructions = screen.findRowByTitle('settingsSourceControl.page.generator.instructionsTitle')?.props.rightElement;
        expect(instructions?.props.placeholder).toBe('settingsSourceControl.commitMessageGenerator.instructionsPlaceholder');

        await act(async () => {
            instructions!.props.onChangeText?.('Use imperative mood');
        });

        expect(setScmCommitMessageGeneratorInstructions).toHaveBeenCalledWith('Use imperative mood');
    });

    it('offers the enabled commit-message Agents by name', async () => {
        setScmCommitMessageGeneratorBackendId.mockClear();
        const screen = await renderSettingsView(<SourceControlSettingsView />);
        const picker = () => screen.findAll((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings.sourceControl.commitMessageAgent')[0];
        expect(picker()).toBeTruthy();
        // No free-text field remains for the Agent.
        expect(screen.findAll((node: any) => node.props?.fieldTestID === 'settings.sourceControl.commitMessageAgent')).toHaveLength(0);
        const items = picker()!.props.items as ReadonlyArray<{ id: string; title: string; subtitle?: string }>;
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) expect(item.subtitle).not.toBe(item.id);
        expect(picker()!.props.selectedId).toBe('codex');
    });
});
