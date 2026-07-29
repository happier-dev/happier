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
    daemonProjectionState,
} = vi.hoisted(() => ({
    setScmCommitStrategy: vi.fn(),
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

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush }),
    }),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: createUseSettingMutableMockFromReader((name) => {
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

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
}));

vi.mock('@/agents/registry/registryCore', () => ({
    DEFAULT_AGENT_ID: 'codex',
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettings,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonProjectionState.current,
}));

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => 'machine-1',
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://server.example', generation: 1 }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('SourceControlSettingsView', () => {
    beforeEach(() => {
        daemonProjectionState.current = { phase: 'unsupported', inputs: null };
        scmGitRepoPreferredBackendValue = 'git';
        scmGitRepoPreferredBackendQualifiedIdValue = null;
        applySettings.mockClear();
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
                    backendsById: {},
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

        expect(screen.findRowByTitle('Acme Stacked SCM')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.gitRoutingPreference.options.git.title')).toBeNull();
        screen.pressRowByTitle('Acme Stacked SCM');
        expect(applySettings).toHaveBeenCalledWith({
            scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
        });

        expect(screen.findRowByTitle(
            'settingsSourceControl.backends.defaultDiffItemTitle:Acme Stacked SCM:settingsSourceControl.diffMode.pending',
        )).toBeTruthy();

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
        const git = screen.findRowByTitle('Git');

        expect(git).toBeTruthy();
        expect(git!.props.rightElement).toBeTruthy();
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
        const external = screen.findRowByTitle('Acme Stacked SCM');
        const git = screen.findRowByTitle('Git');

        expect(external?.props.rightElement).toBeTruthy();
        expect(git?.props.rightElement).toBeFalsy();
        screen.pressRowByTitle('Git');
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

        const retained = screen.findRowByTitle('Acme Stale SCM');
        expect(retained?.props.disabled).toBe(true);
        expect(retained?.props.onPress).toBeUndefined();
        expect(retained?.props.subtitle).toBe('status.offline');
        expect(screen.findRowByTitle('settingsSourceControl.gitRoutingPreference.options.git.title')).toBeNull();
        expect(screen.findRowByTitle('settingsSourceControl.gitRoutingPreference.options.sapling.title')).toBeNull();
    });

    it('renders commit strategy options and updates setting when selected', async () => {
        filesDiffPresentationStyleValue = 'split';
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));

        expect(screen.findRowByTitle('settingsSourceControl.commitStrategy.options.gitStaging.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.commitStrategy.options.atomic.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.gitRoutingPreference.options.git.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.remoteConfirmation.confirmBeforePulling.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.commitStrategy.options.gitStaging.title');
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
        const unified = screen.findRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title');
        const split = screen.findRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.split.title');

        expect(unified).toBeTruthy();
        expect(split).toBeTruthy();
        expect(unified!.props.rightElement).toBeTruthy();
        expect(split!.props.rightElement).toBeFalsy();
    });

    it('only renders backend-supported default diff modes', async () => {
        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Git:settingsSourceControl.diffMode.included')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.pending')).toBeTruthy();
        // When no snapshot/capabilities are available yet, Sapling conservatively only advertises "pending".
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.combined')).toBeNull();
        expect(screen.findRowByTitle('settingsSourceControl.backends.defaultDiffItemTitle:Sapling:settingsSourceControl.diffMode.included')).toBeNull();
    });

    it('allows updating diff syntax highlighting mode', async () => {
        setFilesDiffSyntaxHighlightingMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title');

        expect(setFilesDiffSyntaxHighlightingMode).toHaveBeenCalledWith('simple');
    });

    it('allows updating files diff renderer mode', async () => {
        setFilesDiffRendererMode.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.diffRenderer.options.happier.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.diffRenderer.options.happier.title');

        expect(setFilesDiffRendererMode).toHaveBeenCalledWith('happier');
    });

    it('allows updating diff presentation style', async () => {
        setFilesDiffPresentationStyle.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title');

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('unified');
    });

    it('allows updating changed files row density', async () => {
        setFilesChangedFilesRowDensity.mockClear();

        const { SourceControlSettingsView } = await import('./SourceControlSettingsView');
        const screen = await renderSettingsView(React.createElement(SourceControlSettingsView));
        expect(screen.findRowByTitle('settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title')).toBeTruthy();
        screen.pressRowByTitle('settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title');

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
        const instructions = screen.findByProps({
            placeholder: 'settingsSourceControl.commitMessageGenerator.instructionsPlaceholder',
        });
        expect(instructions).toBeTruthy();

        await act(async () => {
            instructions!.props.onChangeText?.('Use imperative mood');
        });

        expect(setScmCommitMessageGeneratorInstructions).toHaveBeenCalledWith('Use imperative mood');
    });
});
