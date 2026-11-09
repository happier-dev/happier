import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderTestScreen } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native';
import { storage as settingsStorage } from '@/sync/domains/state/storageStore';
import { RichMarkdownEditorPanel } from '@/components/ui/markdown/editor/RichMarkdownEditorPanel';
import { CodeEditorWithFind } from '@/components/ui/code/editor/CodeEditorWithFind';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { MarkdownEditModeMenu } from '@/components/ui/markdown/editorChrome/MarkdownEditModeMenu';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';

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

function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, { wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider> });
}

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
// The static AppPaneProvider import reaches WorkspaceFileDetailsView (via the plugin widget host)
// before the helper's runtime registration, so hoist the same key-identity text boundary here.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));

const fileActionToolbarProps = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/components/workspaces/files/file/FilePageHeader', async (importOriginal) => ({
    // The real menu builder and toolbar stay; only the header's render is captured.
    ...(await importOriginal<typeof import('@/components/workspaces/files/file/FilePageHeader')>()),
    FilePageHeader: (props: any) => {
        fileActionToolbarProps.current = props;
        return React.createElement('FilePageHeader', props, props.rightElement ?? null);
    },
}));

const openableContentViewerState = vi.hoisted(() => ({
    stage: vi.fn(),
    createBinding: vi.fn(),
    stat: vi.fn(),
    read: vi.fn(),
    replaceTab: vi.fn(),
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

vi.mock('@/components/plugins/surfaces/pluginSurfaceOpenableContent', async (importOriginal) => ({
    // Substitute the opaque external file-I/O port, not the shared content classifier.
    ...await importOriginal<typeof import('@/components/plugins/surfaces/pluginSurfaceOpenableContent')>(),
    createWorkspaceFileOpenableContentBinding: (...args: unknown[]) => {
        openableContentViewerState.createBinding(...args);
        return ({
            ref: { kind: 'workspaceFile', handle: 'opaque-workspace-file-ref' },
            stat: (options?: unknown) => openableContentViewerState.stat(options),
            read: (options?: unknown) => openableContentViewerState.read(options),
        });
    },
}));

vi.mock('@/components/workspaces/files/file/FileContentPanel', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/workspaces/files/file/FileContentPanel')>(),
    FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

// Metro's platform projection and the native WebView are the genuine engine boundary.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => import('@/components/ui/code/editor/CodeEditor.native'));
const webViewBoundary = vi.hoisted(() => ({ doc: '', onMessage: null as null | ((event: { nativeEvent: { data: string } }) => void) }));
vi.mock('react-native-webview', async () => {
    const React = await import('react');
    return { WebView: React.forwardRef((props: { onMessage: typeof webViewBoundary.onMessage }, ref) => {
        webViewBoundary.onMessage = props.onMessage;
        React.useImperativeHandle(ref, () => ({
            postMessage(raw: string) {
                const message = JSON.parse(raw) as { type: string; payload?: { doc?: string; requestId?: string } };
                if ((message.type === 'init' || message.type === 'setDoc') && typeof message.payload?.doc === 'string') {
                    webViewBoundary.doc = message.payload.doc;
                }
                if (message.type === 'requestDoc') props.onMessage?.({ nativeEvent: { data: JSON.stringify({
                    v: 1, type: 'docSnapshot', payload: { requestId: message.payload?.requestId, doc: webViewBoundary.doc },
                }) } });
            },
            requestFocus() {},
        }));
        return React.createElement('WebView');
    }) };
});

vi.mock('@/components/workspaces/files/file/FileScreenState', () => ({
    FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
    FileErrorState: (props: any) => React.createElement('FileErrorState', props),
}));

vi.mock('@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton', () => ({
    WorkspaceAugmentedScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/workspaces/files/file/WorkspaceFileDownloadButton', () => ({
    WorkspaceFileDownloadButton: (props: any) => React.createElement('WorkspaceFileDownloadButton', props),
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

const markdownBuffer = vi.hoisted(() => ({ text: '# Title\n\nbody', listeners: new Set<() => void>() }));
const editorState = vi.hoisted(() => ({
    editorSurfaceEnabled: true,
    editorResetKey: 0,
    editorOriginalText: '# Title\n\nbody',
    editorSeedText: '# Title\n\nbody',
    editorHandleRef: { current: null as TextEditorHandle | null },
    onEditorChange: vi.fn((text: string) => {
        markdownBuffer.text = text;
        markdownBuffer.listeners.forEach((listener) => listener());
    }),
    liveValue: {
        get: () => markdownBuffer.text,
        subscribe: (listener: () => void) => { markdownBuffer.listeners.add(listener); return () => { markdownBuffer.listeners.delete(listener); }; },
    },
    getEditorText: () => '# Title\n\nbody',
    editorDirty: false,
    isEditingFile: true,
    isSavingEdits: false,
    fileChangedExternally: false,
    startEditingFile: vi.fn(),
    cancelEditingFile: vi.fn(),
    saveFileEdits: vi.fn(),
    readSnapshot: () => ({ isEditingFile: false, hash: null, dirty: false, conflict: null }),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState', () => ({
    useWorkspaceFileEditorState: () => editorState,
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
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: () => ({
                settings: openableContentViewerState.settings,
                settingsVersion: openableContentViewerState.settingsVersion,
                settingsScope: { serverId: 'srv1', accountId: 'alice' },
            }),
        },
        useSession: () => null,
        useProjectForSession: () => null,
        useSetting: (name: string) => openableContentViewerState.settings[name] ?? null,
        useSettings: () => openableContentViewerState.settings,
        useSettingsSelector: (selector: (settings: typeof openableContentViewerState.settings) => unknown) => selector(openableContentViewerState.settings),
        useSettingsVersion: () => openableContentViewerState.settingsVersion,
        useSettingsReady: () => openableContentViewerState.settingsVersion !== null,
        useWorkspaceScmSnapshot: () => workspaceSnapshot,
        useWorkspaceScmCommitSelectionPaths: () => [],
        useWorkspaceScmCommitSelectionPatches: () => [],
        useWorkspaceScmInFlightOperation: () => null,
        useWorkspaceReviewCommentsDrafts: () => [],
    });
});

beforeEach(() => {
    refreshSpy.mockClear();
    featureState.markdownRichEditor = true;
    settingsStorage.setState((state) => ({ settings: { ...state.settings,
        markdownDefaultEditMode: 'rich', filesMarkdownRichEditorMaxBytes: 1_000_000,
        filesMarkdownRichEditorHtmlRoundTripMaxBytes: 200_000,
    } }));
    editorState.editorSeedText = '# Title\n\nbody';
    markdownBuffer.text = editorState.editorSeedText;
    editorState.editorResetKey = 0;
    editorState.editorHandleRef.current = null;
    editorState.isEditingFile = true;
    openableContentViewerState.stage.mockReset();
    openableContentViewerState.stage.mockReturnValue({
        resource: { destination: { pluginId: 'plugin.preview', localId: 'text-viewer' } },
        tabKey: 'plugin-details:plugin.preview:text-viewer',
    });
    openableContentViewerState.createBinding.mockReset();
    openableContentViewerState.stat.mockReset();
    openableContentViewerState.stat.mockResolvedValue({
        status: 'ready',
        contentClass: 'text',
        mimeType: 'text/plain',
        extension: '.txt',
        sizeBytes: 5,
        revision: 'workspace-file:5:1',
    });
    openableContentViewerState.read.mockReset();
    openableContentViewerState.replaceTab.mockReset();
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
        occurrenceId: 'plugin-preview-occurrence',
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
            interactionEnabled: true,
        },
    };
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
    it('does not coat the containing material plane while keeping file details mounted', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const screen = await renderScreen(<HappierMaterialRoleProvider role="content" resolveMaterialColor={({ translucentColor }) => translucentColor ?? 'transparent'}>
            <WorkspaceFileDetailsView scopeId="workspace:srv1:m1:/workspace" scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }} filePath="README.md" sessionIdForAugmentation={null} />
        </HappierMaterialRoleProvider>);
        mountedScreens.push(screen);
        const root = screen.findAll(node => typeof node.type === 'string' && String(node.type) === 'View')[0]!;
        // The page paints no surface of its own; its containing plane owns the material.
        expect(StyleSheet.flatten(root.props.style).backgroundColor ?? 'transparent').toBe('transparent');
        expect(screen.findAll(node => typeof node.type === 'string' && String(node.type) === 'FilePageHeader')).toHaveLength(1);
    });
    it('loads the built-in preview without openable-content I/O for empty candidates and preferences', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = {
            ...createOpenableContentViewerHost(),
            projection: EMPTY_PLUGIN_UI_PROJECTION,
        } satisfies WorkspaceFileOpenableContentViewerHost;
        editorState.isEditingFile = false;
        openableContentViewerState.settings = {
            workspaceFileViewerPreferencesV1: { v: 1, selections: {} },
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

            expect(refreshSpy).toHaveBeenCalledWith(expect.objectContaining({
                filePath: 'README.txt',
            }));
            expect(screen.findByType('FileContentPanel' as never).props.fileContent).toBe('# Title\n\nbody');
            expect(screen.findAllByType('PluginDetailsViewerChoiceChrome' as never)).toEqual([]);
            expect(openableContentViewerState.createBinding).not.toHaveBeenCalled();
            expect(openableContentViewerState.stat).not.toHaveBeenCalled();
            expect(openableContentViewerState.read).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('preserves openable-content classification for a retained preference without current candidates', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const host = {
            ...createOpenableContentViewerHost(),
            projection: EMPTY_PLUGIN_UI_PROJECTION,
        } satisfies WorkspaceFileOpenableContentViewerHost;
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

            expect(openableContentViewerState.createBinding).toHaveBeenCalledTimes(1);
            expect(openableContentViewerState.stat).toHaveBeenCalledTimes(1);
            const viewerChoice = screen.findByType('PluginDetailsViewerChoiceChrome' as never).props.model;
            expect(viewerChoice.candidates).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'builtin', selected: true }),
                expect.objectContaining({
                    id: 'unavailable:plugin.unavailable:text',
                    disabled: true,
                }),
            ]));
        } finally {
            await screen.unmount();
        }
    });

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

    it('renders the RichMarkdownEditorPanel when mode is rich and the file is eligible', async () => {
        const tree = await mountView();
        expect(tree.findAllByType(MarkdownCodeEditorField).length).toBe(1);
        expect(tree.findAllByType(RichMarkdownEditorPanel).length).toBe(1);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(0);
    });

    it('seeds the rich panel from the hook seedText and resetKey', async () => {
        const tree = await mountView();
        const panel = tree.findByType(RichMarkdownEditorPanel);
        expect(panel.props.value).toBe('# Title\n\nbody');
        expect(panel.props.resetKey).toBe('0:rich:0');
    });

    it('renders the shared raw editor when the setting is raw', async () => {
        settingsStorage.setState((state) => ({ settings: { ...state.settings, markdownDefaultEditMode: 'raw' } }));
        const tree = await mountView();
        expect(tree.findAllByType(CodeEditorWithFind).length).toBe(1);
        expect(tree.findAllByType(RichMarkdownEditorPanel).length).toBe(0);
    });

    it('keeps unsupported Markdown in the shared raw editor', async () => {
        editorState.editorSeedText = 'A note[^1]\n\n[^1]: unsupported\n';
        markdownBuffer.text = editorState.editorSeedText;
        const tree = await mountView();
        expect(tree.findAllByType(CodeEditorWithFind).length).toBe(1);
        expect(tree.findAllByType(RichMarkdownEditorPanel).length).toBe(0);
        expect(tree.findByType(MarkdownEditModeMenu).props.richDisabledReason).toBe('footnotes');
    });

    it('preserves raw edits when they become eligible and switches only on an explicit Rich request', async () => {
        vi.useFakeTimers();
        try {
            editorState.editorSeedText = 'A note[^1]\n\n[^1]: unsupported\n';
            markdownBuffer.text = editorState.editorSeedText;
            const tree = await mountView();
            await act(async () => {
                webViewBoundary.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'ready', payload: { ok: true } }) } });
            });
            const edited = '# Clean draft typed in raw';
            await act(async () => {
                webViewBoundary.doc = edited;
                webViewBoundary.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'docChanged', payload: { doc: edited } }) } });
                // The native editor's existing default change debounce is 250 ms.
                await vi.advanceTimersByTimeAsync(250);
            });
            expect(tree.findAllByType(CodeEditorWithFind)).toHaveLength(1);
            expect(tree.findByType(MarkdownEditModeMenu).props.mode).toBe('raw');
            expect(editorState.editorHandleRef.current?.getValue()).toBe(edited);
            await act(async () => { await tree.findByType(MarkdownEditModeMenu).props.onChange('rich'); });
            expect(tree.findByType(RichMarkdownEditorPanel).props.value).toBe(edited);
        } finally { vi.useRealTimers(); }
    });

    it('retains the active rich document when live eligibility changes', async () => {
        vi.useFakeTimers();
        try {
            const tree = await mountView();
            const edited = 'A note[^1]\n\n[^1]: still in the rich buffer\n';
            await act(async () => {
                webViewBoundary.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'docChanged', payload: { doc: edited } }) } });
                await vi.advanceTimersByTimeAsync(250);
            });
            expect(tree.findAllByType(RichMarkdownEditorPanel)).toHaveLength(1);
            expect(editorState.editorHandleRef.current?.getValue()).toBe(edited);
            expect(tree.findByType(MarkdownEditModeMenu).props.richEligible).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it('offers exactly one mode control owned by the shared field', async () => {
        const tree = await mountView();
        const toolbar = tree.findByType('FilePageHeader' as any);
        expect(toolbar.props.showMarkdownEditToggle).not.toBe(true);
        expect(toolbar.props.menuActions.some((action: { id: string }) => action.id === 'wrap')).toBe(true);
        expect(tree.findAllByType(MarkdownEditModeMenu)).toHaveLength(1);
        expect(tree.findByType(MarkdownEditModeMenu).props.mode).toBe('rich');
    });

    it('does not offer the markdown toggle when the rich editor feature is disabled', async () => {
        // When the flag is off the hook reports ineligible; the view must not show
        // the toggle and must fall back to the raw editor.
        featureState.markdownRichEditor = false;
        const tree = await mountView();
        const toolbar = tree.findByType('FilePageHeader' as any);
        expect(toolbar.props.showMarkdownEditToggle).not.toBe(true);
        expect(tree.findAllByType(MarkdownEditModeMenu)).toHaveLength(0);
        expect(tree.findAllByType(CodeEditorWithFind).length).toBe(1);
        expect(tree.findAllByType(RichMarkdownEditorPanel).length).toBe(0);
    });

    it('passes authoritative eligibility to the shared field mode control', async () => {
        const tree = await mountView();
        expect(tree.findByType(MarkdownEditModeMenu).props.richEligible).toBe(true);
    });

    it('does not show the toggle and stays raw for an editable .mdx file (S3 / R-A1)', async () => {
        // `.mdx` is raw/preview-only in Phase 1: even with the feature on and the
        // hook reporting rich, the view must not surface the toggle and must
        // render the raw editor.
        const tree = await mountView('GUIDE.mdx');
        const toolbar = tree.findByType('FilePageHeader' as any);
        expect(toolbar.props.showMarkdownEditToggle).not.toBe(true);
        expect(tree.findAllByType(MarkdownEditModeMenu)).toHaveLength(0);
        expect(tree.findAllByType(CodeEditorWithFind).length + tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType(RichMarkdownEditorPanel).length).toBe(0);
    });
});
