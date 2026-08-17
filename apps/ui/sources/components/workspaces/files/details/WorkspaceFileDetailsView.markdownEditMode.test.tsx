import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import type {
    PluginUiOpenableContentViewerProjection,
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import type { WorkspaceFileOpenableContentViewerHost } from './WorkspaceFileDetailsView';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetails/workspaceFileDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installWorkspaceFileDetailsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (spec: any) => spec?.default ?? spec?.web },
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));

const fileActionToolbarProps = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/components/workspaces/files/file/FileActionToolbar', () => ({
    FileActionToolbar: (props: any) => {
        fileActionToolbarProps.current = props;
        return React.createElement('FileActionToolbar', props, props.rightElement ?? null);
    },
}));

const openableContentViewerState = vi.hoisted(() => ({
    stage: vi.fn(),
    stat: vi.fn(),
    replaceTab: vi.fn(),
    mutateSettings: vi.fn(),
    settings: {} as Record<string, unknown>,
    settingsVersion: 7,
}));

vi.mock('@/components/appShell/panes/details/surfaces/pluginDetailsDestination', () => ({
    PluginDetailsViewerChoiceChrome: (props: any) => React.createElement('PluginDetailsViewerChoiceChrome', props),
    createPluginDetailsDestinationTab: (input: any) => ({
        key: `plugin-details:${input.destination.pluginId}:${input.destination.localId}`,
        kind: 'plugin-details-destination',
        title: input.title,
        resource: input.destination,
    }),
    usePluginDetailsDestinationLaunchStaging: () => openableContentViewerState.stage,
}));

vi.mock('@/components/plugins/surfaces/pluginSurfaceOpenableContent', () => ({
    createWorkspaceFileOpenableContentBinding: () => ({
        ref: { kind: 'workspaceFile', handle: 'opaque-workspace-file-ref' },
        stat: (options?: unknown) => openableContentViewerState.stat(options),
        read: vi.fn(),
    }),
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettingsOnce: openableContentViewerState.mutateSettings }),
}));

vi.mock('@/components/workspaces/files/file/FileContentPanel', () => ({
    FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/workspaces/files/file/editor/FileEditorPanel', () => ({
    FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/ui/markdown/editor/RichMarkdownEditorPanel', () => ({
    RichMarkdownEditorPanel: (props: any) => React.createElement('RichMarkdownEditorPanel', props),
}));

vi.mock('@/components/workspaces/files/file/FileScreenState', () => ({
    FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
    FileErrorState: (props: any) => React.createElement('FileErrorState', props),
    FileBinaryState: (props: any) => React.createElement('FileBinaryState', props),
}));

vi.mock('@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton', () => ({
    WorkspaceAugmentedScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/workspaces/files/file/WorkspaceFileDownloadButton', () => ({
    WorkspaceFileDownloadButton: (props: any) => React.createElement('WorkspaceFileDownloadButton', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ scopeState: { details: { tabState: {} } }, setDetailsTabState: vi.fn() }),
}));

const featureState = vi.hoisted(() => ({ markdownRichEditor: true }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (id: string) => {
        if (id === 'files.editor') return true;
        if (id === 'files.markdownRichEditor') return featureState.markdownRichEditor;
        return false;
    },
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: () => ({
        onUpsertReviewCommentDraft: vi.fn(),
        onDeleteReviewCommentDraft: vi.fn(),
        onReviewCommentError: vi.fn(),
    }),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () => ({ mode: 'off' }),
}));

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'git_staging'],
    allowsLiveStaging: () => false,
    isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/diff/defaultMode', () => ({ resolveDefaultDiffModeForFile: () => 'pending' }));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fp',
    canUseLineSelection: () => false,
    canStartLineSelection: () => false,
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(async () => true),
    }),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceFileScmStageActions', () => ({
    useWorkspaceFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(async () => true),
    }),
}));

const editorState = vi.hoisted(() => ({
    editorSurfaceEnabled: true,
    editorResetKey: 0,
    editorOriginalText: '# Title\n\nbody',
    editorSeedText: '# Title\n\nbody',
    editorHandleRef: { current: null },
    onEditorChange: vi.fn(),
    getEditorText: () => '# Title\n\nbody',
    editorDirty: false,
    editorTooLarge: false,
    editorChunkTooLarge: false,
    isEditingFile: true,
    isSavingEdits: false,
    fileChangedExternally: false,
    startEditingFile: vi.fn(),
    cancelEditingFile: vi.fn(),
    saveFileEdits: vi.fn(),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState', () => ({
    useWorkspaceFileEditorState: () => editorState,
}));

const markdownEditModeState = vi.hoisted(() => ({
    markdownEditMode: 'rich' as 'raw' | 'rich',
    richEligible: true,
    richDisabledReason: undefined as string | undefined,
    seedText: '# Title\n\nbody',
    resetKey: '0:rich:0',
    onToggle: vi.fn(),
    onUnavailable: vi.fn(),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useMarkdownFileEditMode', () => ({
    useMarkdownFileEditMode: () => markdownEditModeState,
}));

const refreshSpy = vi.fn(async (_input?: any) => ({
    status: 'ready' as const,
    error: null,
    diffContent: null,
    fileContent: { content: '# Title\n\nbody', isBinary: false, contentHash: 'h1' },
    fileWriteSupported: true,
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails', () => ({
    refreshWorkspaceFileDetails: (input: any) => refreshSpy(input),
}));

const workspaceSnapshot: ScmWorkingSnapshot = {
    projectKey: 'workspace:srv1:m1:/workspace',
    fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/workspace', backendId: 'git', mode: '.git', worktrees: [] },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [{
        path: 'README.md',
        kind: 'modified',
        includeStatus: 'unmodified',
        pendingStatus: 'modified',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        previousPath: null,
        stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
    }],
    totals: {
        includedFiles: 0,
        pendingFiles: 1,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 1,
        pendingRemoved: 0,
    },
    capabilities: {} as ScmWorkingSnapshot['capabilities'],
};

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                settings: openableContentViewerState.settings,
                settingsVersion: openableContentViewerState.settingsVersion,
            }),
        },
        useSession: () => null,
        useProjectForSession: () => null,
        useSetting: () => null,
        useSettings: () => openableContentViewerState.settings,
        useSettingsVersion: () => openableContentViewerState.settingsVersion,
        useWorkspaceScmSnapshot: () => workspaceSnapshot,
        useWorkspaceScmCommitSelectionPaths: () => [],
        useWorkspaceScmCommitSelectionPatches: () => [],
        useWorkspaceScmInFlightOperation: () => null,
        useWorkspaceReviewCommentsDrafts: () => [],
        importOriginal,
    });
});

beforeEach(() => {
    featureState.markdownRichEditor = true;
    markdownEditModeState.markdownEditMode = 'rich';
    markdownEditModeState.richEligible = true;
    markdownEditModeState.richDisabledReason = undefined;
    editorState.isEditingFile = true;
    openableContentViewerState.stage.mockReset();
    openableContentViewerState.stage.mockReturnValue({
        resource: { destination: { pluginId: 'plugin.preview', localId: 'text-viewer' } },
        tabKey: 'plugin-details:plugin.preview:text-viewer',
    });
    openableContentViewerState.stat.mockReset();
    openableContentViewerState.stat.mockResolvedValue({
        status: 'ready',
        contentClass: 'text',
        mimeType: 'text/plain',
        extension: '.txt',
        sizeBytes: 5,
        revision: 'workspace-file:5:1',
    });
    openableContentViewerState.replaceTab.mockReset();
    openableContentViewerState.mutateSettings.mockReset();
    openableContentViewerState.mutateSettings.mockResolvedValue({ status: 'applied', value: undefined });
    openableContentViewerState.settings = {};
    openableContentViewerState.settingsVersion = 7;
});

function createOpenableContentViewerHost(): WorkspaceFileOpenableContentViewerHost {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'plugin.preview',
        destinationId: 'text-viewer',
        rendererId: 'text-renderer',
        container: 'detailsTab',
        target: { kind: 'project' },
        instancePolicy: 'singleton',
    });
    if (!binding) throw new Error('test viewer binding must be admitted');
    const entry = {
        id: 'openableContentViewer:plugin.preview:text',
        pluginId: 'plugin.preview',
        contributionKind: 'openableContentViewer',
        descriptorId: 'text',
        identity: { pluginId: 'plugin.preview', localId: 'text' },
        viewer: { contentClasses: ['text'], mimeTypes: ['text/plain'] },
        destination: { pluginId: 'plugin.preview', localId: 'text-viewer' },
    } satisfies PluginUiOpenableContentViewerProjection;
    const placement = {
        id: 'surfacePlacement:plugin.preview:text-viewer',
        pluginId: 'plugin.preview',
        contributionKind: 'surfacePlacement',
        descriptorId: 'text-viewer',
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'text-renderer' },
        display: { developerFallback: 'Text preview' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
    const projection: PluginUiProjectionModel = {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 9,
        surfacePlacementsById: { [placement.id]: placement },
        openableContentViewersById: { [entry.id]: entry },
    };
    const details = {
        tab: {
            key: 'file:README.txt',
            kind: 'workspace-file',
            title: 'README.txt',
            resource: { filePath: 'README.txt' },
            isPreview: true,
            isPinned: false,
        },
        descriptor: {
            surfaceId: 'workspace-file',
            resourceKey: 'file:README.txt',
            scope: {
                kind: 'project',
                workspaceRefId: 'workspace:srv1:m1:/workspace',
                serverId: 'srv1',
                machineId: 'm1',
                rootPath: '/workspace',
            },
            region: 'details',
            status: 'available',
        },
        scope: {
            kind: 'project',
            workspaceRefId: 'workspace:srv1:m1:/workspace',
            serverId: 'srv1',
            machineId: 'm1',
            rootPath: '/workspace',
        },
        region: 'details',
        active: true,
        callbacks: { replaceTab: openableContentViewerState.replaceTab },
    } satisfies DetailsSurfaceRenderInputV1;
    return {
        targetKind: 'project',
        projection,
        platform: 'web',
        details,
        scopedLaunchFacts: {
            serverId: 'srv1',
            machineId: 'm1',
            generation: 9,
            interactionEnabled: true,
        },
    };
}

function createTwoViewerOpenableContentViewerHost(): WorkspaceFileOpenableContentViewerHost {
    const host = createOpenableContentViewerHost();
    const projection = host.projection;
    if (!projection) throw new Error('test viewer projection must be available');
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'plugin.preview',
        destinationId: 'markdown-viewer',
        rendererId: 'markdown-renderer',
        container: 'detailsTab',
        target: { kind: 'project' },
        instancePolicy: 'singleton',
    });
    if (!binding) throw new Error('second test viewer binding must be admitted');
    const entry = {
        id: 'openableContentViewer:plugin.preview:markdown',
        pluginId: 'plugin.preview',
        contributionKind: 'openableContentViewer',
        descriptorId: 'markdown',
        identity: { pluginId: 'plugin.preview', localId: 'markdown' },
        viewer: { contentClasses: ['text'], mimeTypes: ['text/plain'] },
        destination: { pluginId: 'plugin.preview', localId: 'markdown-viewer' },
    } satisfies PluginUiOpenableContentViewerProjection;
    const placement = {
        id: 'surfacePlacement:plugin.preview:markdown-viewer',
        pluginId: 'plugin.preview',
        contributionKind: 'surfacePlacement',
        descriptorId: 'markdown-viewer',
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'markdown-renderer' },
        display: { developerFallback: 'Markdown preview' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
    return {
        ...host,
        projection: {
            ...projection,
            surfacePlacementsById: {
                ...projection.surfacePlacementsById,
                [placement.id]: placement,
            },
            openableContentViewersById: {
                ...projection.openableContentViewersById,
                [entry.id]: entry,
            },
        },
    };
}

type OneShotSettingsMutation = Readonly<{
    expectedSettingsVersion: number;
    mutate: (raw: Readonly<Record<string, unknown>>) => Readonly<{
        settings: Record<string, unknown>;
        value: undefined;
    }>;
}>;

function useAdvancingSettingsMutationFake(): void {
    openableContentViewerState.mutateSettings.mockImplementation(async (input: OneShotSettingsMutation) => {
        if (input.expectedSettingsVersion !== openableContentViewerState.settingsVersion) {
            return { status: 'conflict' };
        }
        const result = input.mutate(openableContentViewerState.settings);
        openableContentViewerState.settings = result.settings;
        openableContentViewerState.settingsVersion += 1;
        return { status: 'applied', value: result.value };
    });
}

function createDeliveredPluginViewerDetails(
    host: WorkspaceFileOpenableContentViewerHost,
    destination: Readonly<{ pluginId: string; localId: string }>,
): DetailsSurfaceRenderInputV1 {
    return {
        ...host.details,
        tab: {
            key: `plugin-details:${destination.pluginId}:${destination.localId}`,
            kind: 'pluginDetailsDestination',
            title: destination.localId,
            resource: { kind: 'pluginDetailsDestination', destination },
            isPreview: true,
            isPinned: false,
        },
    };
}

function installDestinationAwareViewerStage(): void {
    openableContentViewerState.stage.mockImplementation((input: Readonly<{
        placement: Readonly<{ binding: Readonly<{ destination: Readonly<{ pluginId: string; localId: string }> }> }>;
    }>) => ({
        resource: { destination: input.placement.binding.destination },
        tabKey: `plugin-details:${input.placement.binding.destination.pluginId}:${input.placement.binding.destination.localId}`,
    }));
}

function selectTextViewerInSettings(): void {
    openableContentViewerState.settings = {
        workspaceFileViewerPreferencesV1: {
            v: 1,
            selections: {
                'mime:text/plain': {
                    kind: 'plugin',
                    pluginId: 'plugin.preview',
                    contributionLocalId: 'text',
                },
            },
        },
    };
}

const mountedScreens: Array<Awaited<ReturnType<typeof renderScreen>>> = [];

afterEach(async () => {
    for (const screen of mountedScreens.splice(0)) {
        await screen.unmount();
    }
});

async function mountView(filePath = 'README.md') {
    const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
    const screen = await renderScreen(
        <WorkspaceFileDetailsView
            scopeId="workspace:srv1:m1:/workspace"
            scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
            filePath={filePath}
            sessionIdForAugmentation={null}
        />,
    );
    mountedScreens.push(screen);
    await act(async () => {});
    return screen.tree;
}

describe('WorkspaceFileDetailsView (markdown edit mode)', () => {
    it('qualifies matching and temporarily unavailable viewer choices for the fixed chooser chrome', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = createOpenableContentViewerHost();
        editorState.isEditingFile = false;
        openableContentViewerState.settings = {
            workspaceFileViewerPreferencesV1: {
                v: 1,
                selections: {
                    'mime:text/plain': {
                        kind: 'plugin',
                        pluginId: 'plugin.unavailable',
                        contributionLocalId: 'text',
                    },
                },
            },
        };
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/workspace"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
                filePath="README.txt"
                sessionIdForAugmentation={null}
                openableContentViewer={host}
            />,
        );
        try {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const viewerChoice = screen.findByType('PluginDetailsViewerChoiceChrome' as never).props.model;
            const matching = viewerChoice.candidates.find((candidate: { id: string }) => (
                candidate.id === 'openableContentViewer:plugin.preview:text'
            ));
            const unavailable = viewerChoice.candidates.find((candidate: { id: string }) => (
                candidate.id === 'unavailable:plugin.unavailable:text'
            ));
            const { t } = await import('@/text');

            expect(matching).toEqual(expect.objectContaining({ detail: 'plugin.preview' }));
            expect(unavailable).toEqual(expect.objectContaining({
                detail: t('common.unavailable'),
                disabled: true,
            }));
        } finally {
            await screen.unmount();
        }
    });

    it('stages the selected viewer with an opaque binding before replacing the built-in details tab', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = createOpenableContentViewerHost();
        editorState.isEditingFile = false;
        selectTextViewerInSettings();
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/workspace"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
                filePath="README.txt"
                sessionIdForAugmentation={null}
                openableContentViewer={host}
            />,
        );
        try {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(openableContentViewerState.stage).toHaveBeenCalledTimes(1);
            const stageInput = openableContentViewerState.stage.mock.calls[0]?.[0];
            expect(openableContentViewerState.stage).toHaveBeenCalledWith(expect.objectContaining({
                targetKind: 'project',
                scopedLaunchFacts: {
                    serverId: 'srv1',
                    machineId: 'm1',
                    generation: 9,
                    interactionEnabled: true,
                },
                input: { kind: 'workspaceFile', handle: 'opaque-workspace-file-ref' },
                binding: expect.objectContaining({
                    openableContent: expect.objectContaining({
                        ref: { kind: 'workspaceFile', handle: 'opaque-workspace-file-ref' },
                    }),
                }),
            }));
            expect(JSON.stringify(stageInput)).not.toContain('README.txt');
            expect(openableContentViewerState.replaceTab).toHaveBeenCalledWith(
                'file:README.txt',
                expect.objectContaining({
                    kind: 'plugin-details-destination',
                    resource: { pluginId: 'plugin.preview', localId: 'text-viewer' },
                }),
                { intent: 'preview', restoreSourceOnRehydrate: true },
            );

            openableContentViewerState.replaceTab.mockClear();
            stageInput.unavailableFallback({ details: host.details });
            expect(openableContentViewerState.replaceTab).toHaveBeenCalledWith(
                'file:README.txt',
                expect.objectContaining({
                    kind: 'workspace-file',
                    resource: { filePath: 'README.txt' },
                }),
                { intent: 'preview' },
            );
        } finally {
            await screen.unmount();
        }
    });

    it('uses the Settings one-shot mutation before returning a delivered plugin viewer to the built-in tab', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = createOpenableContentViewerHost();
        editorState.isEditingFile = false;
        selectTextViewerInSettings();
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/workspace"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
                filePath="README.txt"
                sessionIdForAugmentation={null}
                openableContentViewer={host}
            />,
        );
        try {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const stageInput = openableContentViewerState.stage.mock.calls[0]?.[0];
            const viewerChoice = stageInput.viewerChoice({ details: host.details });
            if (!viewerChoice) throw new Error('test viewer choice must be available after staging');

            openableContentViewerState.replaceTab.mockClear();
            await act(async () => {
                await viewerChoice.selectCandidate('builtin');
            });

            expect(openableContentViewerState.mutateSettings).toHaveBeenCalledWith(expect.objectContaining({
                expectedSettingsVersion: 7,
            }));
            const mutation = openableContentViewerState.mutateSettings.mock.calls[0]?.[0]?.mutate({});
            expect(mutation.settings.workspaceFileViewerPreferencesV1).toEqual({
                v: 1,
                selections: {
                    'mime:text/plain': { kind: 'builtin' },
                },
            });
            expect(openableContentViewerState.replaceTab).toHaveBeenCalledWith(
                'file:README.txt',
                expect.objectContaining({
                    kind: 'workspace-file',
                    resource: { filePath: 'README.txt' },
                }),
                { intent: 'preview' },
            );
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the built-in view stable when a viewer preference CAS conflicts', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = createOpenableContentViewerHost();
        editorState.isEditingFile = false;
        openableContentViewerState.mutateSettings.mockResolvedValue({ status: 'conflict' });
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/workspace"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
                filePath="README.txt"
                sessionIdForAugmentation={null}
                openableContentViewer={host}
            />,
        );
        try {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const viewerChoice = screen.findByType('PluginDetailsViewerChoiceChrome' as never).props.model;
            await act(async () => {
                await viewerChoice.selectCandidate('openableContentViewer:plugin.preview:text');
            });

            expect(openableContentViewerState.mutateSettings).toHaveBeenCalledWith(expect.objectContaining({
                expectedSettingsVersion: 7,
            }));
            expect(openableContentViewerState.stage).not.toHaveBeenCalled();
            expect(openableContentViewerState.replaceTab).not.toHaveBeenCalled();
            expect(viewerChoice.candidates.find((candidate: { id: string }) => candidate.id === 'builtin'))
                .toEqual(expect.objectContaining({ selected: true }));
        } finally {
            await screen.unmount();
        }
    });

    it('keeps a delivered viewer chooser current across built-in → viewer A → viewer B', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = createTwoViewerOpenableContentViewerHost();
        editorState.isEditingFile = false;
        useAdvancingSettingsMutationFake();
        installDestinationAwareViewerStage();
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/workspace"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
                filePath="README.txt"
                sessionIdForAugmentation={null}
                openableContentViewer={host}
            />,
        );
        try {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const initialChoice = screen.findByType('PluginDetailsViewerChoiceChrome' as never).props.model;
            await act(async () => {
                await initialChoice.selectCandidate('openableContentViewer:plugin.preview:text');
            });

            const firstStage = openableContentViewerState.stage.mock.calls[0]?.[0];
            const viewerChoice = firstStage?.viewerChoice({
                details: createDeliveredPluginViewerDetails(host, {
                    pluginId: 'plugin.preview',
                    localId: 'text-viewer',
                }),
            });
            if (!viewerChoice) throw new Error('test viewer choice must be available after selecting viewer A');

            openableContentViewerState.replaceTab.mockClear();
            await act(async () => {
                await viewerChoice.selectCandidate('openableContentViewer:plugin.preview:markdown');
            });

            expect(openableContentViewerState.mutateSettings.mock.calls.map(([input]) => (
                input.expectedSettingsVersion
            ))).toEqual([7, 8]);
            expect(openableContentViewerState.stage).toHaveBeenCalledTimes(2);
            expect(openableContentViewerState.replaceTab).toHaveBeenCalledWith(
                'plugin-details:plugin.preview:text-viewer',
                expect.objectContaining({
                    kind: 'plugin-details-destination',
                    resource: { pluginId: 'plugin.preview', localId: 'markdown-viewer' },
                }),
                { intent: 'preview', restoreSourceOnRehydrate: true },
            );
            expect(openableContentViewerState.settings.workspaceFileViewerPreferencesV1).toEqual({
                v: 1,
                selections: {
                    'mime:text/plain': {
                        kind: 'plugin',
                        pluginId: 'plugin.preview',
                        contributionLocalId: 'markdown',
                    },
                },
            });
        } finally {
            await screen.unmount();
        }
    });

    it('keeps a delivered viewer chooser current across built-in → viewer A → built-in', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = createTwoViewerOpenableContentViewerHost();
        editorState.isEditingFile = false;
        useAdvancingSettingsMutationFake();
        installDestinationAwareViewerStage();
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/workspace"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
                filePath="README.txt"
                sessionIdForAugmentation={null}
                openableContentViewer={host}
            />,
        );
        try {
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const initialChoice = screen.findByType('PluginDetailsViewerChoiceChrome' as never).props.model;
            await act(async () => {
                await initialChoice.selectCandidate('openableContentViewer:plugin.preview:text');
            });

            const firstStage = openableContentViewerState.stage.mock.calls[0]?.[0];
            const viewerChoice = firstStage?.viewerChoice({
                details: createDeliveredPluginViewerDetails(host, {
                    pluginId: 'plugin.preview',
                    localId: 'text-viewer',
                }),
            });
            if (!viewerChoice) throw new Error('test viewer choice must be available after selecting viewer A');

            openableContentViewerState.replaceTab.mockClear();
            await act(async () => {
                await viewerChoice.selectCandidate('builtin');
            });

            expect(openableContentViewerState.mutateSettings.mock.calls.map(([input]) => (
                input.expectedSettingsVersion
            ))).toEqual([7, 8]);
            expect(openableContentViewerState.replaceTab).toHaveBeenCalledWith(
                'plugin-details:plugin.preview:text-viewer',
                expect.objectContaining({
                    kind: 'workspace-file',
                    resource: { filePath: 'README.txt' },
                }),
                { intent: 'preview' },
            );
            expect(openableContentViewerState.settings.workspaceFileViewerPreferencesV1).toEqual({
                v: 1,
                selections: {
                    'mime:text/plain': { kind: 'builtin' },
                },
            });
        } finally {
            await screen.unmount();
        }
    });

    it('renders the RichMarkdownEditorPanel when mode is rich and the file is eligible', async () => {
        const tree = await mountView();
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(0);
    });

    it('seeds the rich panel from the hook seedText and resetKey', async () => {
        const tree = await mountView();
        const panel = tree.findByType('RichMarkdownEditorPanel' as any);
        expect(panel.props.value).toBe('# Title\n\nbody');
        expect(panel.props.resetKey).toBe('0:rich:0');
    });

    it('renders the raw FileEditorPanel when mode is raw', async () => {
        markdownEditModeState.markdownEditMode = 'raw';
        const tree = await mountView();
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('renders the raw FileEditorPanel when mode is rich but the file is ineligible', async () => {
        markdownEditModeState.richEligible = false;
        markdownEditModeState.richDisabledReason = 'footnotes';
        const tree = await mountView();
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('passes the markdown toggle props to the FileActionToolbar', async () => {
        const tree = await mountView();
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.showMarkdownEditToggle).toBe(true);
        expect(toolbar.props.markdownEditMode).toBe('rich');
        expect(typeof toolbar.props.onMarkdownEditMode).toBe('function');
    });

    it('does not offer the markdown toggle when the rich editor feature is disabled', async () => {
        // When the flag is off the hook reports ineligible; the view must not show
        // the toggle and must fall back to the raw editor.
        featureState.markdownRichEditor = false;
        markdownEditModeState.richEligible = false;
        markdownEditModeState.markdownEditMode = 'rich';
        const tree = await mountView();
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.showMarkdownEditToggle).toBe(false);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('passes the authoritative richEligible to the FileActionToolbar (N2)', async () => {
        markdownEditModeState.richEligible = true;
        const tree = await mountView();
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.markdownRichEligible).toBe(true);
    });

    it('does not show the toggle and stays raw for an editable .mdx file (S3 / R-A1)', async () => {
        // `.mdx` is raw/preview-only in Phase 1: even with the feature on and the
        // hook reporting rich, the view must not surface the toggle and must
        // render the raw editor.
        markdownEditModeState.markdownEditMode = 'rich';
        markdownEditModeState.richEligible = true;
        const tree = await mountView('GUIDE.mdx');
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.showMarkdownEditToggle).toBe(false);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });
});
