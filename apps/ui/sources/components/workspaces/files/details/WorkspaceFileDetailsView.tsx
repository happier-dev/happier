import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { buildFilePageMenuActions, FilePageHeader, FilePageToolbar } from '@/components/workspaces/files/file/FilePageHeader';
import { FilePagePluginViewerHeader } from '@/components/workspaces/files/file/FilePagePluginViewerHeader';
import { resolveFilePageEditControl } from '@/components/workspaces/files/file/filePageModel';
import { FileCodeSkeleton, FilePartialFooter, FileReadingLine, FileTooLargeState, formatFilePageBytes } from '@/components/workspaces/files/file/FilePageStates';
import { resolveFilePageMediaFacts, type FilePageMediaInfo } from '@/components/workspaces/files/file/filePageMediaFacts';
import type { FileDisplayMode } from '@/components/workspaces/files/file/filePageModel';
import type { FileMenuContext } from '@/components/workspaces/files/file/fileMenus';
import { useFilePageCodeIntelligence } from '@/components/workspaces/files/intelligence/useFilePageCodeIntelligence';
import { useFilePageSharing } from '@/components/workspaces/files/file/useFilePageSharing';
import { workspaceFileDetailsTabKey } from '@/components/appShell/panes/details/fileDetailsTab';
import { useFilePageDetailsActions } from '@/components/workspaces/files/file/useFilePageDetailsActions';
import { reconstructWorkspaceFileTextBytes } from '@/sync/ops/workspaceFileSystem/workspaceFileTextDecoding';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retryMachineReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useWorkspaceFileLiveMoment } from './workspaceFileDetails/useWorkspaceFileLiveMoment';
import { FileErrorState, FileLoadingState } from '@/components/workspaces/files/file/FileScreenState';
import { FileViewerBody, type FileViewerStageHandle } from '@/components/workspaces/files/file/FileViewerBody';
import type { ImageWellInfo } from '@/components/ui/media/ImageWell';
import { PdfZoomMenu } from '@/components/ui/media/pdf/PdfZoomMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { PdfPageInfo } from '@/components/ui/media/pdf/PdfViewerStates';
import type { PdfViewPosition } from '@/components/ui/media/pdf/pdfViewPosition';
import type { PdfZoom } from '@/components/ui/media/pdf/pdfZoom';
import { CheckoutUnreachableState, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { FileContentPanel, resolveFileCodeGeometry } from '@/components/workspaces/files/file/FileContentPanel';
import { FileChangesSection, type FileChangesDiffSurface } from '@/components/workspaces/files/file/changes/FileChangesRegions';
import { useFileChangesReview } from '@/components/workspaces/files/file/changes/useFileChangesReview';
import { useFileChangesRollback } from '@/components/workspaces/files/file/changes/useFileChangesActions';
import { createSessionCommitDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createProjectCommitDetailsTab } from '@/components/projects/detail/projectDetailsTabBuilders';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { FileChangesScope } from '@happier-dev/protocol/scm';
import { FileViewerFindSurface } from './FileViewerFindSurface';
import type { FileViewerFindMemory } from './useFileViewerFind';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { FileEditorPanel, FileMarkdownEditorPanel, type FileEditorPanelProps } from '@/components/workspaces/files/file/editor/FileEditorPanel';
import { FileEditorAskControls } from '@/components/workspaces/files/file/editor/FileEditorAskControls';
import { useFileEditorInlineComment } from '@/components/workspaces/files/file/editor/FileEditorInlineComment';
import { FileReadAskControls } from '@/components/workspaces/files/file/FileReadAskControls';
import { useAskSelectionTargetContext } from '@/components/ui/code/selection/useAskSelection';
import { FileEditorNoticeLine } from '@/components/workspaces/files/file/editor/FileEditorNoticeLine';
import { buildEditorChangeMarkers } from '@/components/ui/code/editor/editorChangeMarkers';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { FileEditorCompareBody } from '@/components/workspaces/files/file/editor/FileEditorCompareBody';
import { useFilePageAttribution } from '@/components/workspaces/files/file/useFilePageAttribution';
import { FileBlameNote, useFileBlameRegion } from '@/components/workspaces/files/file/blame/FileBlameRegion';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';

import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useDetailsTabChrome } from '@/components/appShell/panes/details/workspace/detailsTabChrome';
import type { ScmEntryKind } from '@happier-dev/protocol';
import { getPreferredLanguage, t } from '@/text';

import { buildFileLineSelectionFingerprint, canStartLineSelection, canUseLineSelection } from '@/scm/scmLineSelection';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { allowsLiveStaging, isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { useFileDetailsDiffMode } from '@/scm/diff/useFileDetailsDiffMode';
import { buildScmDiffSnapshotSignature } from '@/scm/diffCache/scmDiffCacheKey';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Modal } from '@/modal';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1,
    WorkspaceFileViewerPreferencesV1Schema,
    applyWorkspaceFileViewerPreferenceMutationV1,
} from '@happier-dev/protocol/account/settings/workspaceFileViewerPreferencesV1';
import type { OpenableContentStatResultV1 } from '@happier-dev/protocol';

import { useWorkspaceFileDetailsLoading } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileDetailsLoading';
import { recordRecentWorkspaceFile } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceFileEditorState, type WorkspaceFileEditStart } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState';
import { readCodeViewReadingLine } from '@/components/ui/code/view/readCodeViewReadingLine';
import { readWorkspaceFileEditorDraft, type WorkspaceFileEditorDraft } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft';
import { useWorkspaceFileEditorCommands } from './workspaceFileDetails/useWorkspaceFileEditorCommands';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import {
    storage,
    useActiveServerAccountScope,
    useProjectForSession,
    useSessionListPreferredMetadata,
    useSetting,
    useSettingsSelector,
    useSettingsVersion,
    useWorkspaceReviewCommentsDrafts,
    useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmCommitSelectionPaths,
    useWorkspaceScmInFlightOperation,
    useWorkspaceScmSnapshot,
} from '@/sync/domains/state/storage';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { selectScmChangedFiles, type ScmFileStatus } from '@/scm/scmStatusFiles';
import { useFileScmStageActions } from '@/hooks/session/files/useFileScmStageActions';
import { useWorkspaceFileScmStageActions } from '@/hooks/workspaces/scm/useWorkspaceFileScmStageActions';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveFileDetailsDisplayMode } from './workspaceFileDetails/resolveFileDetailsDisplayMode';
import { resolveFileDetailsRenderableDiff } from './workspaceFileDetails/resolveFileDetailsRenderableDiff';
import { useWorkspaceFileView } from './workspaceFileDetails/useWorkspaceFileView';
import { resolveFilePageHeaderModel } from '../file/filePageModel';
import { registerFileViewActionOwner, type FileViewActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { WorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import { buildWorkspaceFileReferenceAnchorKey } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import { extractSelectedDiffLineKeysFromPatch } from '@/scm/scmPatchSelection';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import type { DetailsTab, DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    PluginDetailsViewerChoiceChrome,
    createPluginDetailsDestinationTab,
    usePluginDetailsDestinationLaunchStaging,
    type PluginDetailsViewerChoiceModel,
} from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';
import { createWorkspaceFileOpenableContentBinding, deriveWorkspaceFileOpenableContentKind, type PluginSurfaceOpenableContentBinding } from '@/components/plugins/surfaces/pluginSurfaceOpenableContent';
import { resolvePluginSurfaceDestinationLabel } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    createPluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveTrackPresenceLines, useTrackPresenceForPath } from '@/components/sessions/files/track/TrackPauseSignal';
import { FileEditorAgentPresence } from '@/components/workspaces/files/file/editor/FileEditorAgentPresence';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDeviceType } from '@/utils/platform/responsive';
import {
    resolveWorkspaceFileViewerCandidates,
    resolveWorkspaceFileViewerChoiceModel,
    isWorkspaceFileOpenableContentViewerEligible,
    type WorkspaceFileViewerChoice,
    type WorkspaceFileViewerChoiceModel,
    type WorkspaceFileViewerMatch,
} from './workspaceFileDetails/resolveWorkspaceFileViewer';
import { usePhoneAskSheet } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';


/** How long a jump target stays highlighted (a deep link, or Track's scroll to the agent's region). */
const JUMP_TO_ANCHOR_HOLD_MS = 8000;
export type WorkspaceFileDeepLinkAnchor = Readonly<{
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
}>;

/**
 * The details renderer contributes its current scoped host facts; this shared
 * file-details owner remains responsible for selecting and launching an
 * openable-content viewer.
 */
export type WorkspaceFileOpenableContentViewerHost = Readonly<{
    targetKind: 'session' | 'project';
    projection: PluginUiProjectionModel | null | undefined;
    /** The mounted details host's current platform, not an authored viewer capability. */
    platform: LocalServicePreviewPlatform;
    details: DetailsSurfaceRenderInputV1;
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts;
}>;

export type WorkspaceFileDetailsViewProps = Readonly<{
    scopeId: string;
    scope: WorkspaceScopeBase | null;
    filePath: string;
    initialView?: WorkspaceFileLinkView;
    deepLinkAnchor?: WorkspaceFileDeepLinkAnchor | null;
    findSeed?: FileFindSeed | null;
    onFindSeedConsumed?: () => void;
    sessionIdForAugmentation?: string | null;
    workspaceRefId?: string | null;
    /** The real host owns link/publication identity; augmentation never selects it. */
    targetKind?: 'session' | 'project';
    presentation?: 'screen' | 'panel';
    /** The host names the repository (the Code page): its root leads the header's breadcrumb. */
    breadcrumbRoot?: string | null;
    /** A breadcrumb folder opens here (the Code page's own listing); otherwise it reveals the folder in Files. */
    onOpenFolder?: (folderPath: string) => void;
    onStartEditingFile?: () => void;
    onRevealInFilesTree?: (path: string) => void;
    onOpenChanges?: () => void;
    openableContentViewer?: WorkspaceFileOpenableContentViewerHost;
}>;

function toBuiltinDetailsTab(tab: DetailsTabState): DetailsTab {
    return {
        key: tab.key,
        kind: tab.kind,
        title: tab.title,
        ...(tab.subtitle === undefined ? {} : { subtitle: tab.subtitle }),
        resource: tab.resource,
    };
}

function detailsTabIntent(tab: DetailsTabState): 'pinned' | 'preview' {
    return tab.isPreview ? 'preview' : 'pinned';
}

function resolveFileStatusLabel(kind: ScmEntryKind): string {
    switch (kind) {
        case 'added': return t('detailsSurface.file.statusAdded');
        case 'deleted': return t('detailsSurface.file.statusDeleted');
        case 'renamed': return t('detailsSurface.file.statusRenamed');
        case 'copied': return t('detailsSurface.file.statusCopied');
        case 'untracked': return t('detailsSurface.file.statusUntracked');
        case 'conflicted': return t('detailsSurface.file.statusConflicted');
        default: return t('detailsSurface.file.statusModified');
    }
}

function unavailableViewerChoiceId(choice: Extract<WorkspaceFileViewerChoice, { kind: 'unavailable' }>): string {
    return `unavailable:${choice.preference.pluginId}:${choice.preference.contributionLocalId}`;
}

function findWorkspaceFileViewerChoice(
    model: WorkspaceFileViewerChoiceModel,
    candidateId: string,
): WorkspaceFileViewerChoice | null {
    for (const choice of model.choices) {
        if (choice.kind === 'builtin' && candidateId === 'builtin') return choice;
        if (choice.kind === 'text' && candidateId === 'text') return choice;
        if (choice.kind === 'plugin' && candidateId === choice.candidate.candidate.entry.id) return choice;
        if (choice.kind === 'unavailable' && candidateId === unavailableViewerChoiceId(choice)) return choice;
    }
    return null;
}

function readWorkspaceFileViewerPreferences(value: unknown) {
    const parsed = WorkspaceFileViewerPreferencesV1Schema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1;
}

function createWorkspaceFileViewerChoiceChromeModel(input: Readonly<{
    model: WorkspaceFileViewerChoiceModel;
    selectedPluginViewerId: string | null;
    canSelect: boolean;
    selectCandidate: (candidateId: string, details: DetailsSurfaceRenderInputV1) => Promise<void>;
    details: DetailsSurfaceRenderInputV1;
    localizePluginText: PluginLocalizedTextResolver;
}>): PluginDetailsViewerChoiceModel {
    return Object.freeze({
        candidates: Object.freeze(input.model.choices.map((choice) => {
            if (choice.kind === 'builtin') {
                const selected = input.selectedPluginViewerId === null && input.model.selected.kind !== 'text';
                return Object.freeze({
                    id: 'builtin',
                    label: t('common.default'),
                    selected,
                    ...(input.canSelect || selected ? {} : { disabled: true }),
                });
            }
            if (choice.kind === 'text') {
                return Object.freeze({ id: 'text', label: t('files.viewer.openAsText'), selected: input.model.selected.kind === 'text' });
            }
            if (choice.kind === 'plugin') {
                const selected = choice.candidate.candidate.entry.id === input.selectedPluginViewerId;
                return Object.freeze({
                    id: choice.candidate.candidate.entry.id,
                    label: resolvePluginSurfaceDestinationLabel(
                        choice.candidate.candidate.placement,
                        input.localizePluginText,
                    ),
                    detail: choice.candidate.identity.pluginId,
                    selected,
                    ...(input.canSelect || selected ? {} : { disabled: true }),
                });
            }
            return Object.freeze({
                id: unavailableViewerChoiceId(choice),
                label: `${choice.preference.pluginId}/${choice.preference.contributionLocalId}`,
                detail: t('common.unavailable'),
                selected: false,
                disabled: true,
            });
        })),
        selectCandidate: async (candidateId) => {
            await input.selectCandidate(candidateId, input.details);
        },
    });
}

function stageWorkspaceFilePluginViewer(input: Readonly<{
    stage: ReturnType<typeof usePluginDetailsDestinationLaunchStaging>;
    host: WorkspaceFileOpenableContentViewerHost;
    binding: PluginSurfaceOpenableContentBinding;
    selected: WorkspaceFileViewerMatch;
    model: WorkspaceFileViewerChoiceModel;
    currentDetails: DetailsSurfaceRenderInputV1;
    originalBuiltinTab: DetailsTab;
    originalBuiltinTabState: DetailsTabState;
    canSelect: boolean;
    selectCandidate: (candidateId: string, details: DetailsSurfaceRenderInputV1) => Promise<void>;
    localizePluginText: PluginLocalizedTextResolver;
    header?: (context: Readonly<{ details: DetailsSurfaceRenderInputV1 }>) => React.ReactNode;
}>): boolean {
    const replaceTab = input.currentDetails.callbacks.replaceTab;
    if (!replaceTab) return false;
    const selectedPluginViewerId = input.selected.candidate.entry.id;
    const receipt = input.stage({
        placement: input.selected.candidate.placement,
        targetKind: input.host.targetKind,
        scopedLaunchFacts: input.host.scopedLaunchFacts,
        input: input.binding.ref,
        binding: Object.freeze({ openableContent: input.binding }),
        viewerChoice: (context) => createWorkspaceFileViewerChoiceChromeModel({
            model: input.model,
            selectedPluginViewerId,
            canSelect: input.canSelect,
            selectCandidate: input.selectCandidate,
            details: context.details,
            localizePluginText: input.localizePluginText,
        }),
        ...(input.header ? { header: input.header } : {}),
        unavailableFallback: (fallback) => {
            fallback.details.callbacks.replaceTab?.(
                fallback.details.tab.key,
                input.originalBuiltinTab,
                { intent: detailsTabIntent(input.originalBuiltinTabState) },
            );
        },
    });
    if (!receipt) return false;
    replaceTab(
        input.currentDetails.tab.key,
        createPluginDetailsDestinationTab({
            destination: receipt.resource.destination,
            ...(receipt.resource.instanceKey === undefined ? {} : { instanceKey: receipt.resource.instanceKey }),
            title: resolvePluginSurfaceDestinationLabel(
                input.selected.candidate.placement,
                input.localizePluginText,
            ),
        }),
        {
            intent: detailsTabIntent(input.originalBuiltinTabState),
            restoreSourceOnRehydrate: true,
        },
    );
    return true;
}

function WorkspaceFileOpenableContentViewerControls(props: Readonly<{
    scope: WorkspaceScopeBase | null;
    filePath: string;
    sessionId?: string | null;
    workspaceRefId?: string | null;
    host: WorkspaceFileOpenableContentViewerHost | undefined;
    /** The built-in editor holds the body (or is about to): the selected plugin viewer waits until it is done. */
    builtinBodyRequired?: boolean;
    /** Ask the built-in tab to open straight into its editor (Edit in the plugin viewer's header). */
    requestEdit?: () => void;
    builtinViewer?: 'default' | 'text';
    isBinaryContent?: boolean;
    selectBuiltinViewer: (viewer: 'default' | 'text') => void;
    onRevealInFilesTree?: (path: string) => void;
}>): React.ReactElement | null {
    const settings = useSettingsSelector((settings) => ({
        workspaceFileViewerPreferencesV1: settings.workspaceFileViewerPreferencesV1,
    }));
    const settingsVersion = useSettingsVersion();
    const stage = usePluginDetailsDestinationLaunchStaging();
    const host = props.host;
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: host?.projection,
            locale: pluginLocale,
        }),
        [host?.projection, pluginLocale],
    );
    const deviceType = useDeviceType();
    const runtimeFormFactor = host
        ? resolvePluginUiRuntimeFormFactor({ deviceType })
        : 'tablet';
    const candidates = React.useMemo(() => (
        host?.projection
            ? resolveWorkspaceFileViewerCandidates({
                projection: host.projection,
                targetKind: host.targetKind,
                platform: host.platform,
                formFactor: runtimeFormFactor,
            })
            : []
    ), [host?.platform, host?.projection, host?.targetKind, runtimeFormFactor]);
    const preferences = React.useMemo(() => (
        readWorkspaceFileViewerPreferences(settings.workspaceFileViewerPreferencesV1)
    ), [settings.workspaceFileViewerPreferencesV1]);
    const hasViewerDemand = candidates.length > 0 || Object.keys(preferences.selections).length > 0;
    const binding = React.useMemo(() => (
        props.scope && host && hasViewerDemand
            ? createWorkspaceFileOpenableContentBinding({ target: props.scope, filePath: props.filePath })
            : null
    ), [hasViewerDemand, host?.targetKind, props.filePath, props.scope]);
    const [stat, setStat] = React.useState<OpenableContentStatResultV1 | null>(null);

    React.useEffect(() => {
        if (!binding) {
            setStat(null);
            return;
        }
        const controller = new AbortController();
        let current = true;
        void binding.stat({ signal: controller.signal }).then((next) => {
            if (current) setStat(next);
        });
        return () => {
            current = false;
            controller.abort();
        };
    }, [binding]);

    const choiceModel = React.useMemo(() => (
            resolveWorkspaceFileViewerChoiceModel({
                metadata: stat?.status === 'ready' ? stat : deriveWorkspaceFileOpenableContentKind(props.filePath, undefined, props.isBinaryContent),
                preferences,
                availablePluginViewers: stat?.status === 'ready' ? candidates : [],
                builtinViewer: props.builtinViewer,
            })
    ), [candidates, preferences, props.builtinViewer, props.filePath, props.isBinaryContent, stat]);
    const originalBuiltinTabState = host?.details.tab ?? null;
    const originalBuiltinTab = React.useMemo(() => (
        originalBuiltinTabState ? toBuiltinDetailsTab(originalBuiltinTabState) : null
    ), [originalBuiltinTabState]);
    const scope = props.scope;
    const textContent = stat?.status === 'ready' && stat.contentClass === 'text';
    const sizeBytes = stat?.status === 'ready' ? stat.sizeBytes : null;
    const { requestEdit, onRevealInFilesTree, filePath } = props;
    const header = React.useCallback((context: Readonly<{ details: DetailsSurfaceRenderInputV1 }>) => (scope ? (
        <FilePagePluginViewerHeader scope={scope} filePath={filePath} sizeBytes={sizeBytes}
            sessionId={props.sessionId} workspaceRefId={props.workspaceRefId} targetKind={host?.targetKind}
            onRevealInFilesTree={onRevealInFilesTree}
            onEdit={textContent && requestEdit && originalBuiltinTab && originalBuiltinTabState ? () => {
                requestEdit();
                context.details.callbacks.replaceTab?.(context.details.tab.key, originalBuiltinTab,
                    { intent: detailsTabIntent(originalBuiltinTabState) });
            } : undefined} />
    ) : null), [scope, filePath, sizeBytes, textContent, requestEdit, onRevealInFilesTree, originalBuiltinTab, originalBuiltinTabState,
        props.sessionId, props.workspaceRefId, host?.targetKind]);

    const selectCandidate = React.useCallback(async (
        candidateId: string,
        currentDetails: DetailsSurfaceRenderInputV1,
    ) => {
        if (candidateId === 'text') {
            props.selectBuiltinViewer('text');
            if (originalBuiltinTab && originalBuiltinTabState) currentDetails.callbacks.replaceTab?.(currentDetails.tab.key, originalBuiltinTab,
                    { intent: detailsTabIntent(originalBuiltinTabState) });
            return;
        }
        if (candidateId === 'builtin' && (!hasViewerDemand || stat?.status !== 'ready')) {
            props.selectBuiltinViewer('default');
            return;
        }
        if (!host || !binding || !stat || stat.status !== 'ready' || !originalBuiltinTab || !originalBuiltinTabState) return;
        const currentSettingsState = storage.getState();
        if (currentSettingsState.settingsVersion === null || currentSettingsState.settingsScope === null) return;
        const currentChoiceModel = resolveWorkspaceFileViewerChoiceModel({
            metadata: stat,
            preferences: readWorkspaceFileViewerPreferences(
                currentSettingsState.settings.workspaceFileViewerPreferencesV1,
            ),
            availablePluginViewers: candidates,
        });
        const choice = findWorkspaceFileViewerChoice(currentChoiceModel, candidateId);
        if (!choice || choice.kind === 'unavailable' || choice.kind === 'text') return;
        const viewer = choice.kind === 'builtin'
            ? { kind: 'builtin' as const }
            : {
                kind: 'plugin' as const,
                pluginId: choice.candidate.identity.pluginId,
                contributionLocalId: choice.candidate.identity.localId,
            };
        try {
            const result = await getSyncSingleton().mutateAccountSettingsOnce({
                expectedSettingsScope: currentSettingsState.settingsScope,
                expectedSettingsVersion: currentSettingsState.settingsVersion,
                mutate: (raw) => Object.freeze({
                    settings: {
                        ...applyWorkspaceFileViewerPreferenceMutationV1(raw, {
                            kind: 'select',
                            selector: currentChoiceModel.preferenceSelector,
                            viewer,
                        }),
                    },
                    value: undefined,
                }),
            });
            if (result.status !== 'applied') return;
        } catch {
            return;
        }

        if (choice.kind === 'builtin') {
            props.selectBuiltinViewer('default');
            currentDetails.callbacks.replaceTab?.(
                currentDetails.tab.key,
                originalBuiltinTab,
                { intent: detailsTabIntent(originalBuiltinTabState) },
            );
            return;
        }
        props.selectBuiltinViewer('default');
        stageWorkspaceFilePluginViewer({
            stage,
            host,
            binding,
            selected: choice.candidate,
            model: currentChoiceModel,
            currentDetails,
            originalBuiltinTab,
            originalBuiltinTabState,
            canSelect: true,
            selectCandidate,
            localizePluginText,
            header,
        });
    }, [
        binding,
        candidates,
        host,
        header,
        localizePluginText,
        originalBuiltinTab,
        originalBuiltinTabState,
        stage,
        stat,
        hasViewerDemand,
        props.selectBuiltinViewer,
    ]);

    React.useEffect(() => {
        if (
            !host?.details.active
            || props.builtinBodyRequired === true
            || !binding
            || !choiceModel
            || choiceModel.selected.kind !== 'plugin'
            || !originalBuiltinTab
            || !originalBuiltinTabState
        ) {
            return;
        }
        stageWorkspaceFilePluginViewer({
            stage,
            host,
            binding,
            selected: choiceModel.selected.candidate,
            model: choiceModel,
            currentDetails: host.details,
            originalBuiltinTab,
            originalBuiltinTabState,
            canSelect: settingsVersion !== null,
            selectCandidate,
            localizePluginText,
            header,
        });
    }, [
        header,
        binding,
        choiceModel,
        host,
        localizePluginText,
        originalBuiltinTab,
        originalBuiltinTabState,
        props.builtinBodyRequired,
        selectCandidate,
        settingsVersion,
        stage,
    ]);

    if (!host || !choiceModel || choiceModel.selected.kind === 'plugin') return null;
    // One entry point per choice (lab FV2b): while the built-in view shows, its binary identity card carries the quiet
    // "Open as text" link, so the band does not repeat it; once the text shows, the band is the way back to Default.
    const bandModel = choiceModel.selected.kind === 'text' ? choiceModel
        : { ...choiceModel, choices: choiceModel.choices.filter((choice) => choice.kind !== 'text') };
    // A choice of one is no choice: the band appears only when the file has another way to open (FV2b, gap 18).
    if (bandModel.choices.length < 2) return null;
    const viewerChoice = createWorkspaceFileViewerChoiceChromeModel({
        model: bandModel,
        selectedPluginViewerId: null,
        // Default only writes the Account preference when a plugin viewer could own the file; otherwise it is the tab's.
        canSelect: settingsVersion !== null || !hasViewerDemand,
        selectCandidate,
        details: host.details,
        localizePluginText,
    });
    return <PluginDetailsViewerChoiceChrome model={viewerChoice} />;
}

type WorkspaceFileDetailsPersistedDraft = WorkspaceFileEditorDraft;

export function WorkspaceFileDetailsView(props: WorkspaceFileDetailsViewProps) {
    if (!props.scope) {
        return <SurfaceStateCard
            testID="file-details-scope-unavailable"
            kind="unavailable"
            title={t('common.unavailable')}
            reason={t('errors.daemonUnavailableBody')}
        />;
    }
    return <WorkspaceFileDetailsPage {...props} scope={props.scope} />;
}

function WorkspaceFileDetailsPage(props: WorkspaceFileDetailsViewProps & Readonly<{ scope: WorkspaceScopeBase }>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const mountedRef = useMountedRef();
    const presentation = props.presentation ?? 'screen';
    const checkoutReachability = useCheckoutReachability(props.scope);
    const constrainWidth = presentation === 'screen';
    const pane = useAppPaneScope(props.scopeId);
    const destinationFocused = useDestinationFocus();
    const getAskTargetContext = useAskSelectionTargetContext(React.useCallback(() => ({ openDetailsTab: pane.openDetailsTab }), [pane.openDetailsTab]));
    const editorAccountScope = useActiveServerAccountScope(props.scope?.serverId ?? null);
    const patchDetailsTabState = pane.patchDetailsTabState;
    const filePath = props.filePath;
    const scope = props.scope;
    const findSurfaceId = `file:${props.scopeId}:${filePath}`;
    const findRuntime = useFindSurfaceRuntime();
    const findFocusRoot = React.useRef<View | null>(null);

    const sessionId = (props.sessionIdForAugmentation ?? '').trim();
    const sessionAddress = normalizeSessionAddress(scope?.serverId, sessionId);
    const ownerMetadata = useSessionListPreferredMetadata(sessionAddress ?? sessionId);
    const project = useProjectForSession(sessionId, scope?.serverId);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: typeof ownerMetadata?.path === 'string' ? ownerMetadata.path : null,
        projectPath: project?.key?.rootPath ?? (scope?.rootPath ?? null),
    });
    const [copyContentBusy, setCopyContentBusy] = React.useState(false);

    const tabKey = workspaceFileDetailsTabKey(filePath, props.initialView?.rootPath);
    const { view: fileView, initialChanges, patchView: patchFileView } = useWorkspaceFileView(pane, tabKey);
    const isActive = props.openableContentViewer?.details.active ?? (presentation === 'screen' || (pane.scopeState?.details?.isOpen === true && pane.scopeState.details.activeTabKey === tabKey));
    const rememberFind = React.useCallback((find: FileViewerFindMemory) => patchFileView({ findQuery: find.query, findOpen: find.open }), [patchFileView]);
    const rememberReadingLine = React.useCallback((scrollLine: number) => patchFileView({ scrollLine }), [patchFileView]);
    const readingMemory = React.useMemo(() => ({ identity: `${props.scopeId}:${tabKey}`, line: fileView.scrollLine, active: isActive, remember: rememberReadingLine }), [props.scopeId, tabKey, fileView.scrollLine, isActive, rememberReadingLine]);
    const persistedDraft = readWorkspaceFileEditorDraft(pane.scopeState?.details?.tabState?.[tabKey], editorAccountScope?.accountId ?? null);
    // Mirrors the editor state (declared below, after the content it needs) for the loader's diff request.
    const [diffWhileEditing, setDiffWhileEditing] = React.useState(persistedDraft?.isEditingFile === true);
    const persistDraft = React.useCallback((draft: WorkspaceFileDetailsPersistedDraft | null) => {
        patchDetailsTabState(tabKey, draft ?? {
            accountId: null, isEditingFile: false, editorOriginalText: undefined,
            editorOriginalHash: undefined, editorText: undefined,
        });
    }, [patchDetailsTabState, tabKey]);

    const deepLinkAnchor = props.deepLinkAnchor ?? null;
    const deepLinkKey = React.useMemo(() => {
        if (!deepLinkAnchor) return '';
        return buildWorkspaceFileReferenceAnchorKey({
            filePath,
            source: deepLinkAnchor.source,
            anchor: deepLinkAnchor.anchor,
        });
    }, [deepLinkAnchor, filePath]);

    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const fileEditorFeatureEnabled = useFeatureEnabled('files.editor');
    const showLineNumbers = useSetting('showLineNumbers');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const filesEditorAutoSave = useSetting('filesEditorAutoSave');
    const filesEditorChangeDebounceMs = useSetting('filesEditorChangeDebounceMs');
    const filesEditorBridgeMaxChunkBytes = useSetting('filesEditorBridgeMaxChunkBytes');
    const filesEditorWebMonacoEnabled = useSetting('filesEditorWebMonacoEnabled');
    const filesEditorNativeCodeMirrorEnabled = useSetting('filesEditorNativeCodeMirrorEnabled');
    const filesImagePreviewMaxBytes = useSetting('filesImagePreviewMaxBytes');

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const scmSnapshot = useWorkspaceScmSnapshot(scope);
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
    const inFlightScmOperation = useWorkspaceScmInFlightOperation(scope);
    const fileEntry = React.useMemo(
        () => scmSnapshot?.entries.find((entry) => entry.path === filePath) ?? null,
        [filePath, scmSnapshot]
    );
    const hasConflicts = scmSnapshot?.hasConflicts === true;
    // The Review list's order, so a reviewed file's Next file is the one the list shows after it.
    const changedPaths = React.useMemo(() => scmSnapshot ? selectScmChangedFiles(scmSnapshot).map(file => file.fullPath) : undefined, [scmSnapshot]);
    const snapshotSignature = React.useMemo(() => scmSnapshot ? buildScmDiffSnapshotSignature(scmSnapshot) : null, [scmSnapshot]);

    const [displayMode, setDisplayMode] = React.useState<FileDisplayMode>(() => (
        fileView.mode === 'edit' || (fileView.mode === undefined && persistedDraft?.isEditingFile) ? 'file' : fileView.mode ?? (deepLinkAnchor?.source === 'file' ? 'file'
            : fileEntry ? 'diff' : resolveFileViewerKind({ path: filePath }).kind === 'markdown' ? 'markdown' : 'file')
    ));
    const requestedDisplayMode = fileView.mode ?? null;
    const selectBuiltinViewer = React.useCallback((viewer: 'default' | 'text') => {
        patchFileView({ viewer, mode: 'file' });
        setDisplayMode('file');
    }, [patchFileView]);
    const openAsText = React.useCallback(() => selectBuiltinViewer('text'), [selectBuiltinViewer]);
    const [diffMode, setDiffMode] = useFileDetailsDiffMode({
        fileKey: `${scope?.serverId}:${scope?.machineId}:${scope?.rootPath}:${filePath}`,
        snapshot: scmSnapshot,
        backendOverrides: scmDefaultDiffModeByBackend as Record<string, ScmDiffArea> | undefined,
        hasIncludedDelta: fileEntry?.hasIncludedDelta === true,
        hasPendingDelta: fileEntry?.hasPendingDelta === true,
    });
    const [selectedLineKeys, setSelectedLineKeys] = React.useState<Set<string>>(new Set());
    const [commitSelectionModeActive, setCommitSelectionModeActive] = React.useState(false);
    const [rangeSelectionActive, setRangeSelectionActive] = React.useState(false);
    const [reviewCommentModeActive, setReviewCommentModeActive] = React.useState(false);
    const [jumpToAnchor, setJumpToAnchor] = React.useState<ReviewCommentAnchor | null>(deepLinkAnchor?.anchor ?? null);

    const hasIncludedDelta = fileEntry?.hasIncludedDelta === true;
    const hasPendingDelta = fileEntry?.hasPendingDelta === true;
    const includeExcludeEnabled = allowsLiveStaging({
        strategy: scmCommitStrategy,
        snapshot: scmSnapshot,
    });
    const virtualSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
        && scmSnapshot?.capabilities?.writeCommitPathSelection === true;
    const virtualLineSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
        && scmSnapshot?.capabilities?.writeCommitLineSelection === true;
    const isSelectedForCommit = commitSelectionPaths.includes(filePath)
        || commitSelectionPatches.some((p) => p.path === filePath);
    const appliedSelectedLineKeys = React.useMemo(() => {
        const keys = new Set<string>();
        for (const patchSelection of commitSelectionPatches) {
            if (patchSelection.path !== filePath) continue;
            for (const key of extractSelectedDiffLineKeysFromPatch(patchSelection.patch)) {
                keys.add(key);
            }
        }
        return keys;
    }, [commitSelectionPatches, filePath]);
    const lineSelectionFingerprint = React.useMemo(
        () => buildFileLineSelectionFingerprint(fileEntry),
        [fileEntry]
    );
    const { fileContent, diffContent, setDiffContent, isLoading, isDiffLoading, error, fileWriteSupported, setFileWriteSupported, staleSince, lastOwnWriteHash, tooLarge, refreshAll, readFileForSave, publishSavedFile } = useWorkspaceFileDetailsLoading({
        scope, filePath, diffMode,
        accountId: editorAccountScope?.accountId ?? null,
        fileEntryKind: fileEntry?.kind ?? null,
        isBinaryContent: fileEntry?.stats.isBinary,
        fileHasIncludedDelta: fileEntry?.hasIncludedDelta,
        previewSlice: fileView.previewSlice,
        readAsText: fileView.viewer === 'text',
        maxImagePreviewBytes: typeof filesImagePreviewMaxBytes === 'number' ? filesImagePreviewMaxBytes : null,
        // The shared data owner also acquires current after-text for Changes' document holder.
        // Editing a changed file reads the diff for its gutter marks (P4-R9).
        includeDiff: (displayMode === 'diff' && (scmSnapshot == null || fileEntry != null)) || (diffWhileEditing && fileEntry != null),
        includeFile: displayMode !== 'diff',
        snapshotSignature,
        isActive,
        refreshFingerprint: `${lineSelectionFingerprint ?? 'none'}:${scmSnapshot?.fetchedAt ?? 'none'}`,
    });
    const recentActivation = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!isActive) { recentActivation.current = null; return; }
        if (!scope || isLoading || isDiffLoading || error || (!fileContent && diffContent === null)) return;
        const workspaceKey = tryBuildWorkspaceCacheKey(scope);
        if (!workspaceKey) return;
        const activation = `${workspaceKey}\u0000${filePath}`;
        if (recentActivation.current === activation) return;
        recentActivation.current = activation;
        const state = storage.getState();
        const previous = state.localSettings.recentWorkspaceFilesV1;
        const next = recordRecentWorkspaceFile(previous, workspaceKey, filePath);
        if (next !== previous) state.applyLocalSettings({ recentWorkspaceFilesV1: next });
    }, [diffContent, error, fileContent, filePath, isActive, isDiffLoading, isLoading, scope]);
    const copyFileContent = React.useCallback(async () => {
        if (!fileContent || fileContent.isBinary || copyContentBusy) return;
        setCopyContentBusy(true);
        try {
            const copied = await setClipboardStringSafe(fileContent.content);
            if (!copied && mountedRef.current) Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        } finally {
            if (mountedRef.current) setCopyContentBusy(false);
        }
    }, [copyContentBusy, fileContent, mountedRef]);
    const lineSelectionEnabled = !fileContent?.partial && canUseLineSelection({
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualLineSelectionEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        diffMode,
        diffContent,
    });
    const lineSelectionCanStart = !fileContent?.partial && canStartLineSelection({
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualLineSelectionEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        hasPendingDelta,
        hasIncludedDelta,
        diffContent,
    });
    const effectiveLineSelectionEnabled = lineSelectionEnabled && commitSelectionModeActive;
    const displayedSelectedLineKeys = commitSelectionModeActive ? selectedLineKeys : appliedSelectedLineKeys;

    const selectionResetKey = React.useMemo(
        () => [
            diffMode,
            diffContent ?? '',
            lineSelectionFingerprint ?? '',
        ].join('\n'),
        [diffContent, diffMode, lineSelectionFingerprint],
    );
    const previousSelectionResetRef = React.useRef<{
        key: string;
        diffContent: string | null;
    } | null>(null);
    React.useEffect(() => {
        const previous = previousSelectionResetRef.current;
        if (previous === null) {
            previousSelectionResetRef.current = { key: selectionResetKey, diffContent };
            return;
        }
        if (previous.key === selectionResetKey) return;
        previousSelectionResetRef.current = { key: selectionResetKey, diffContent };
        if (previous.diffContent === null && diffContent !== null) {
            return;
        }
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
        setReviewCommentModeActive(false);
    }, [diffContent, selectionResetKey]);

    React.useEffect(() => {
        if (!lineSelectionCanStart) {
            setSelectedLineKeys(new Set());
            setCommitSelectionModeActive(false);
            setRangeSelectionActive(false);
            setReviewCommentModeActive(false);
        }
    }, [lineSelectionCanStart]);

    const language = getFileLanguageFromPath(filePath);
    // Binary bytes under a text-looking name (`firmware.bin`) are a binary file, not a "Text file" (FV2b).
    const fileViewer = resolveFileViewerKind({ path: filePath, mimeType: fileContent?.binaryMime,
        isBinaryContent: fileEntry?.stats.isBinary === true || fileContent?.isBinary === true });
    // Markdown and SVG open in Preview (P3 §5 modes; PROGRAM D-F1: an SVG renders as an image), Source one tap away.
    const previewKind = fileViewer.kind === 'markdown' || fileViewer.kind === 'svg';
    const previewAvailable = fileContent?.isBinary !== true && previewKind && typeof fileContent?.content === 'string';
    const hasRenderableDiff = React.useMemo(
        () => resolveFileDetailsRenderableDiff({ diffContent }),
        [diffContent],
    );

    React.useEffect(() => {
        if (!deepLinkAnchor) {
            setJumpToAnchor(null);
            return;
        }

        setJumpToAnchor(deepLinkAnchor.anchor);

        const timer = setTimeout(() => {
            setJumpToAnchor(null);
        }, JUMP_TO_ANCHOR_HOLD_MS);

        return () => clearTimeout(timer);
    }, [deepLinkKey]);

    const sessionStageActions = useFileScmStageActions({
        sessionId,
        serverId: sessionAddress?.serverId,
        sessionPath,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        diffMode,
        diffContent,
        lineSelectionEnabled: effectiveLineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });

    const workspaceStageActions = useWorkspaceFileScmStageActions({
        scope,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        diffMode,
        diffContent,
        lineSelectionEnabled: effectiveLineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });

    const { isApplyingStage, handleStage, applySelectedLines } = sessionId ? sessionStageActions : workspaceStageActions;
    const applySelectedLinesRef = React.useRef(applySelectedLines);
    applySelectedLinesRef.current = applySelectedLines;

    const toggleSelectedLine = React.useCallback((key: string) => {
        if (!effectiveLineSelectionEnabled) return;
        setRangeSelectionActive(false);
        setSelectedLineKeys((previous) => {
            const next = new Set(previous);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, [effectiveLineSelectionEnabled]);

    const fileName = filePath.split('/').pop() || filePath;
    const filePathDir = filePath.split('/').slice(0, -1).join('/');
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(filePath);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(scope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(scope);

    // The writing agent's name for the editor's conflict and Undo copy; "the version on disk" when unknown.
    const editorAttribution = useFilePageAttribution({ address: sessionAddress, filePath, workspaceRoot: scope?.rootPath ?? null, active: isActive,
        content: fileContent?.isBinary ? null : fileContent?.content });
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([scope?.serverId, editorAccountScope?.accountId, props.scopeId, filePath]),
        serverId: scope?.serverId ?? '', onExecuted: refreshAll,
    });
    const stopEditing = React.useCallback(() => {
        if (fileView.mode === 'edit') patchFileView({ mode: 'file' });
    }, [fileView.mode, patchFileView]);
    const editorState = useWorkspaceFileEditorState({
        scope: scope ?? { serverId: 'unknown', machineId: 'unknown', rootPath: '/' },
        accountId: editorAccountScope?.accountId ?? null, filePath, displayMode,
        fileText: fileContent?.isBinary || fileContent?.partial ? null : (fileContent?.content ?? null),
        fileHash: fileContent?.isBinary || fileContent?.partial ? null : (fileContent?.contentHash ?? null),
        encoding: fileContent?.encoding, unreachable: checkoutReachability.unreachable,
        fileWriteSupported, setFileWriteSupported,
        fileEditorFeatureEnabled: fileEditorFeatureEnabled === true && !fileContent?.partial,
        filesEditorWebMonacoEnabled: filesEditorWebMonacoEnabled === true,
        filesEditorNativeCodeMirrorEnabled: filesEditorNativeCodeMirrorEnabled === true,
        filesEditorAutoSave: filesEditorAutoSave === true,
        filesEditorChangeDebounceMs: typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : 0,
        mountedRef, refreshAll, readFileForSave, publishSavedFile, persistedDraft: persistedDraft ?? null, persistDraft,
        initialEditing: fileView.mode === 'edit', onStopEditing: stopEditing,
        panePersistenceFailed: pane.persistenceFailed, agentName: editorAttribution.agentName,
        requestApproval: approval.requestApproval,
    });
    const approvalRouter = useRouter();
    const editorApprovalId = approval.approvalPending ? approval.approvalId : null;
    const openEditorApproval = React.useMemo(() => editorApprovalId && scope
        ? () => approvalRouter.pushRetainingCurrent(buildApprovalHref(editorApprovalId, scope.serverId)) : null,
    [approvalRouter, editorApprovalId, scope]);
    const { editorSurfaceEnabled, isEditingFile, editorResetKey, editorSeedText, editorHandleRef,
        onEditorChange, editorDirty, saveFileEdits, cancelEditingFile, startEditingFile,
        liveValue, initialLine, onEditorReady } = editorState;
    const isEditorSelected = isEditingFile && (fileView.mode === 'edit' || fileView.mode === undefined);
    const onDisplayMode = React.useCallback(async (mode: FileDisplayMode) => {
        if (isEditingFile) {
            await editorHandleRef.current?.flushPendingChange();
            if (!mountedRef.current || !editorState.readSnapshot().isEditingFile) return false;
        }
        patchFileView({ mode });
        setDisplayMode(mode);
        return true;
    }, [editorHandleRef, editorState.readSnapshot, isEditingFile, mountedRef, patchFileView]);
    React.useEffect(() => { setDiffWhileEditing(isEditingFile); }, [isEditingFile]);
    // Ask reads the mounted editor's selection; the handle exists once the engine reports ready.
    const [readyEditorHandle, setReadyEditorHandle] = React.useState<typeof editorHandleRef.current>(null);
    const bindCodeIntelligenceEditor = React.useRef<() => void>(() => undefined);
    const onCodeEditorReady = React.useCallback(() => {
        onEditorReady();
        setReadyEditorHandle(editorHandleRef.current);
        bindCodeIntelligenceEditor.current();
    }, [editorHandleRef, onEditorReady]);
    // The selection toolbar's Comment in Edit: the page's inline composer under the selected lines.
    const editorComment = useFileEditorInlineComment({ enabled: reviewCommentsEnabled === true && isEditingFile, scope: scope ?? null,
        filePath, handle: readyEditorHandle, savedText: fileContent?.isBinary ? undefined : fileContent?.content,
        onError: reviewDraftHandlers.onReviewCommentError });
    // View → Edit swaps in one frame once the engine reports ready (P4 §3.5): until then the editor mounts unseen beneath
    // the read view, so a cold engine load never shows a half-made editor. A remounted engine reports ready again.
    const codeEditorMounted = displayMode === 'file' && isEditorSelected && fileViewer.kind !== 'markdown';
    React.useEffect(() => { if (!codeEditorMounted) setReadyEditorHandle(null); }, [codeEditorMounted]);
    const codeEditorWarming = codeEditorMounted && readyEditorHandle === null;
    const codeGeometryText = fileContent?.isBinary ? editorSeedText : fileContent?.content ?? editorSeedText;
    const codeGeometry = React.useMemo(() => resolveFileCodeGeometry({ text: codeGeometryText, reviewCommentsEnabled, reviewCommentModeActive }), [codeGeometryText, reviewCommentsEnabled, reviewCommentModeActive]);
    // The tab strip shows this tab's unsaved dot; the editor state is the only owner of that fact.
    const detailsTabChrome = useDetailsTabChrome();
    React.useEffect(() => {
        detailsTabChrome.setUnsaved(editorDirty);
    }, [detailsTabChrome, editorDirty]);
    React.useEffect(() => () => detailsTabChrome.setUnsaved(false), [detailsTabChrome]);
    const openableContentViewerEligible = isWorkspaceFileOpenableContentViewerEligible({
        isEditingFile,
        hasPersistedEditingDraft: persistedDraft?.isEditingFile === true,
    });

    const isMarkdownFile = fileViewer.kind === 'markdown';

    React.useEffect(() => {
        setDisplayMode(resolveFileDetailsDisplayMode({
            requestedMode: requestedDisplayMode,
            persistedEditing: isEditingFile || persistedDraft?.isEditingFile === true,
            deepLinkSource: deepLinkAnchor?.source ?? null,
            hasRenderableDiff,
            hasFileContent: Boolean(fileContent),
            previewAvailable,
            knownChanged: fileEntry !== null,
            previewKind,
        }));
    }, [requestedDisplayMode, deepLinkAnchor?.source, fileContent, hasRenderableDiff, isEditingFile, previewAvailable, persistedDraft?.isEditingFile, fileEntry, previewKind]);

    const readBodyRef = React.useRef<View | null>(null);
    // Edit opens where the person is (P4-R10): from View on the same top row with the caret on the selection,
    // from Changes at the change in focus. Press events and menu entries pass no position.
    const changesEditLineRef = React.useRef<number | null>(null);
    const handleStartEditingFile = React.useCallback((at?: WorkspaceFileEditStart) => {
        const requested = typeof at?.line === 'number' ? at : undefined;
        const reading = requested ?? (displayMode === 'file' ? readCodeViewReadingLine(readBodyRef.current) ?? undefined
            : displayMode === 'diff' && changesEditLineRef.current !== null ? { line: changesEditLineRef.current } : undefined);
        patchFileView({ mode: 'edit' }); setDisplayMode('file');
        props.onStartEditingFile?.(); startEditingFile(reading);
    }, [displayMode, patchFileView, props.onStartEditingFile, startEditingFile]);
    // Edit from a plugin viewer's header lands here with a one-shot request: open the built-in editor once the
    // text is held (the request is cleared first, so a reload never re-enters editing by itself).
    const requestEditFromViewer = React.useCallback(() => patchFileView({ startEditing: true }), [patchFileView]);
    const editRequested = fileView.startEditing === true;
    React.useEffect(() => {
        if (!editRequested || !fileContent || fileContent.isBinary) return;
        patchFileView({ startEditing: undefined });
        handleStartEditingFile();
    }, [editRequested, fileContent, handleStartEditingFile, patchFileView]);
    const focusedGroup = pane.scopeState?.details?.groups?.find(group => group.id === pane.scopeState?.details?.focusedGroupId);
    const editorHeader = useWorkspaceFileEditorCommands({
        editor: editorState, tabKey, onStart: handleStartEditingFile,
        file: scope ? { scope, path: filePath } : undefined,
        serverId: scope?.serverId ?? null, accountId: editorAccountScope?.accountId ?? null,
        focused: isActive && isEditorSelected && (presentation === 'screen' || focusedGroup?.activeTabKey === tabKey),
    });

    const surfaceSize = useSurfaceStateSize();
    const editorAccessory = React.useMemo(() => (Platform.OS !== 'web' || surfaceSize === 'phone') ? {
        save: {
            visible: editorHeader.status !== 'conflict',
            enabled: editorHeader.status === 'dirty' || editorHeader.status === 'saving',
            busy: editorHeader.status === 'saving',
            tone: editorHeader.refusal ? 'default' as const : 'primary' as const,
            onPress: editorHeader.onSave,
        },
    } : null, [editorHeader.status, editorHeader.refusal, editorHeader.onSave, surfaceSize]);
    // Changes is offered from the moment the tree / SCM knows the file changed (its diff may still be on the way,
    // so the segment never appears late), and for changed images whose Changes is the visual compare (P5 U8).
    const changesOffered = hasRenderableDiff || (fileEntry !== null
        && (diffContent === null || fileViewer.kind === 'image' || fileViewer.kind === 'svg'));
    const headerModel = resolveFilePageHeaderModel({
        kind: fileViewer.kind,
        hasRenderableDiff: changesOffered, deleted: fileEntry?.kind === 'deleted',
        partial: Boolean(fileContent?.partial),
        // Changes opened first holds only the text diff; the file is text all the same, so Edit is offered there
        // and opens at the change in focus once the file's text arrives (P4-R10).
        hasText: (fileContent?.isBinary === false && typeof fileContent.content === 'string') || persistedDraft?.isEditingFile === true
            || (typeof diffContent === 'string' && diffContent.length > 0 && fileEntry?.stats.isBinary !== true && fileContent?.isBinary !== true),
        writeSupported: fileWriteSupported || persistedDraft?.isEditingFile === true,
        editorAvailable: editorSurfaceEnabled,
    });
    const fileViewActionOwner = React.useRef<FileViewActionOwner | null>(null);
    fileViewActionOwner.current = {
        // A retained destination keeps its local File tab selected, but cannot own current-File commands.
        tabId: tabKey, active: isActive && destinationFocused, serverId: scope?.serverId ?? null,
        accountId: editorAccountScope?.accountId ?? null,
        mode: isEditorSelected ? 'edit' : headerModel.modes.find(option => option.displayMode === displayMode)?.id ?? 'view',
        changesScope: fileView.changesScope, blame: fileView.blame ?? false,
        availableModes: [...headerModel.modes.map(option => option.id), ...(headerModel.editUnavailableReason === null ? ['edit' as const] : [])],
        blameAvailable: scmSnapshot?.capabilities?.readBlame === true,
        changesScopeAvailable: scope !== null,
        get search() { return codeIntelligence.search; },
        set: async patch => {
            if (patch.mode === 'edit') handleStartEditingFile();
            else if (patch.mode) {
                const option = headerModel.modes.find(option => option.id === patch.mode);
                if (!option) return false;
                if (!await onDisplayMode(option.displayMode)) return false;
            }
            const { mode: _mode, ...viewPatch } = patch;
            if (Object.keys(viewPatch).length > 0) patchFileView(viewPatch);
            return true;
        },
    };
    React.useEffect(() => registerFileViewActionOwner(JSON.stringify([props.scopeId, tabKey]), () => fileViewActionOwner.current!), [props.scopeId, tabKey]);

    // Navigation and the public view Action apply through the same mounted page owner.
    const initialViewKey = JSON.stringify([filePath, props.initialView?.view, props.initialView?.blame, props.deepLinkAnchor]);
    const appliedInitialView = React.useRef({ key: initialViewKey, view: false, blame: false });
    React.useEffect(() => {
        if (!isActive || (!fileContent && !hasRenderableDiff && persistedDraft?.isEditingFile !== true)) return;
        const requested = props.initialView;
        const owner = fileViewActionOwner.current;
        if (appliedInitialView.current.key !== initialViewKey) appliedInitialView.current = { key: initialViewKey, view: false, blame: false };
        if (!owner || (!requested?.view && requested?.blame === undefined)) return;
        // References name file coordinates; Markdown/SVG therefore open their Source mode.
        const mode = requested.view === 'view' && !owner.availableModes.includes('view')
            ? headerModel.modes.find(option => option.displayMode === 'file')?.id ?? headerModel.modes[0]?.id : requested.view;
        let current = true;
        void (async () => {
            try {
                if (!appliedInitialView.current.view && mode && owner.availableModes.includes(mode)) {
                    const applied = owner.mode === mode || await owner.set({ mode });
                    if (!current) return;
                    appliedInitialView.current.view = applied;
                }
                if (!appliedInitialView.current.blame && requested.blame !== undefined && (owner.blameAvailable || requested.blame === false)) {
                    const applied = owner.blame === requested.blame || await owner.set({ blame: requested.blame });
                    if (current) appliedInitialView.current.blame = applied;
                }
            } catch (error) {
                if (current) Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed'));
            }
        })();
        return () => { current = false; };
    }, [initialViewKey, isActive, fileContent, hasRenderableDiff, persistedDraft?.isEditingFile,
        headerModel.editUnavailableReason, scmSnapshot?.capabilities?.readBlame]);

    const onStageFile = React.useCallback(() => {
        void handleStage(true);
    }, [handleStage]);

    const onUnstageFile = React.useCallback(() => {
        void handleStage(false);
    }, [handleStage]);

    const onApplySelectedLines = React.useCallback(async () => {
        setRangeSelectionActive(false);
        const applied = await applySelectedLinesRef.current();
        if (applied === true) {
            setCommitSelectionModeActive(false);
        }
    }, []);

    const onClearSelection = React.useCallback(() => {
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
    }, []);

    const onStartLineSelection = React.useCallback(() => {
        if (!lineSelectionCanStart) return;
        setReviewCommentModeActive(false);
        setDisplayMode('diff');
        if (!lineSelectionEnabled) {
            setDiffContent(null);
            setDiffMode(hasPendingDelta ? 'pending' : 'included');
        }
        setSelectedLineKeys(new Set(appliedSelectedLineKeys));
        setCommitSelectionModeActive(true);
        setRangeSelectionActive(false);
    }, [appliedSelectedLineKeys, hasPendingDelta, lineSelectionCanStart, lineSelectionEnabled]);

    const onStartRangeSelection = React.useCallback(() => {
        if (!lineSelectionEnabled || !commitSelectionModeActive) return;
        setRangeSelectionActive(true);
    }, [commitSelectionModeActive, lineSelectionEnabled]);

    const onToggleReviewCommentMode = React.useCallback((active: boolean) => {
        setReviewCommentModeActive(active);
        if (!active) return;
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
        setSelectedLineKeys(new Set());
    }, []);
    // The selection toolbar's Comment: comment mode on, the inline composer on the selected lines.
    const [commentRangeRequest, setCommentRangeRequest] = React.useState<React.ComponentProps<typeof FileContentPanel>['commentRangeRequest']>(null);
    const onCommentSelectedRange = React.useCallback((range: Readonly<{ startLine: number; endLine: number; side?: 'before' | 'after' }>) => {
        onToggleReviewCommentMode(true);
        setCommentRangeRequest((previous) => ({ startLine: range.startLine, endLine: range.endLine, side: range.side, key: (previous?.key ?? 0) + 1 }));
    }, [onToggleReviewCommentMode]);

    const onRefresh = React.useCallback(() => {
        void refreshAll();
    }, [refreshAll]);

    const fileStatusForHeaderActions = React.useMemo<ScmFileStatus | null>(() => {
        if (!fileEntry) return null;
        const segments = fileEntry.path.split('/');
        const statusFileName = segments[segments.length - 1] || fileEntry.path;
        const statusFilePath = segments.slice(0, -1).join('/');
        const useIncludedStats = fileEntry.hasIncludedDelta && !fileEntry.hasPendingDelta;
        return {
            fileName: statusFileName,
            filePath: statusFilePath,
            fullPath: fileEntry.path,
            status: fileEntry.kind,
            isIncluded: useIncludedStats,
            hasIncludedDelta: fileEntry.hasIncludedDelta,
            linesAdded: useIncludedStats ? fileEntry.stats.includedAdded : fileEntry.stats.pendingAdded,
            linesRemoved: useIncludedStats ? fileEntry.stats.includedRemoved : fileEntry.stats.pendingRemoved,
            oldPath: fileEntry.previousPath ?? undefined,
            isBinary: fileEntry.stats.isBinary,
            isComplete: fileEntry.stats.isComplete,
        };
    }, [fileEntry]);

    // The agent's write landing while you read (P3-R8, FV1m): the content updates in place, its new lines
    // tint once, and the attribution reads "Updated by {agent} just now".
    const reducedMotion = useReducedMotionPreference();
    const liveMoment = useWorkspaceFileLiveMoment({
        resourceKey: JSON.stringify([scope?.serverId, scope?.machineId, scope?.rootPath, filePath]),
        content: fileContent,
        isActive,
        isEditing: isEditingFile,
        hasDraft: persistedDraft?.isEditingFile === true,
        ownWriteHash: lastOwnWriteHash,
        reducedMotion,
    });
    // Track's agent caret and wash (P5 §3.10): where this Session's agent writes in this file now.
    const trackPresence = useTrackPresenceForPath(filePath);
    const trackPresenceText = trackPresence && !trackPresence.region && !fileContent?.isBinary ? fileContent?.content : undefined;
    const agentPresence = React.useMemo(() => {
        if (!trackPresence) return null;
        const lines = resolveTrackPresenceLines(trackPresence, trackPresenceText);
        return lines ? { ...lines, agentId: trackPresence.agentId, agentName: trackPresence.agentName, reducedMotion } : null;
    }, [reducedMotion, trackPresence, trackPresenceText]);
    // Track's scroll (P5 §3.10): Track decides when, this page resolves where — the same lines the caret uses.
    const trackRevealSeq = trackPresence?.reveal?.seq ?? null;
    const trackRevealLine = agentPresence?.startLine ?? null;
    const appliedTrackReveal = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (trackRevealSeq === null || trackRevealLine === null || appliedTrackReveal.current === trackRevealSeq) return;
        appliedTrackReveal.current = trackRevealSeq;
        const anchor: ReviewCommentAnchor = { kind: 'fileLine', startLine: trackRevealLine };
        setJumpToAnchor(anchor);
        const timer = setTimeout(() => setJumpToAnchor((current) => current === anchor ? null : current), JUMP_TO_ANCHOR_HOLD_MS);
        return () => clearTimeout(timer);
    }, [trackRevealLine, trackRevealSeq]);
    const [liveMomentAt, setLiveMomentAt] = React.useState<number | null>(null);
    React.useEffect(() => { if (liveMoment) setLiveMomentAt(Date.now()); }, [liveMoment]);
    const attributionUpdatedAt = Math.max(editorAttribution.updatedAt ?? 0, liveMomentAt ?? 0) || null;

    // ── The page's chrome: one header, one `⋯` list, one share owner (P3 §3.2, §3.3) ──
    const phonePage = surfaceSize === 'phone';
    const safeAreaInsets = useSafeAreaInsets();
    const machineReachable = !checkoutReachability.unreachable;
    const unavailableReason = t('projects.checkouts.notAnswering', { machine: checkoutReachability.machineName });
    const heldText = fileContent && !fileContent.isBinary && !fileContent.partial ? fileContent.content : null;
    const cachedContent = React.useMemo(() => {
        if (machineReachable || !fileContent) return null;
        const bytes = reconstructWorkspaceFileTextBytes({ text: fileContent.content,
            complete: !fileContent.isBinary && !fileContent.partial, encoding: fileContent.encoding });
        return bytes ? { bytes, fileName, mimeType: fileContent.binaryMime ?? fileViewer.mimeType ?? 'text/plain' } : null;
    }, [fileContent, fileName, fileViewer.mimeType, machineReachable]);
    const share = useFilePageSharing({
        scope, filePath, accountScope: editorAccountScope, sessionId, fileRootPath: props.initialView?.rootPath,
        workspaceRefId: props.workspaceRefId, targetKind: props.targetKind ?? props.openableContentViewer?.targetKind,
        machineReachable,
        unavailableReason,
        cachedContent,
        sourceFacts: [filePathDir.split('/').filter(Boolean).join(' › '),
            typeof fileContent?.binarySizeBytes === 'number' ? formatFilePageBytes(fileContent.binarySizeBytes) : null,
            checkoutReachability.machineName ? t('files.pane.page.fromMachine', { machine: checkoutReachability.machineName }) : null,
        ].filter(Boolean).join(' · '),
    });
    const fileDetails = useFilePageDetailsActions({ path: filePath, kind: fileViewer.kind, kindLabel: t(fileViewer.labelKey as never) as string, language, content: fileContent });
    const effectiveWrapLines = fileView.wrap ?? wrapLinesInDiffs;
    const isBinaryContent = fileContent?.isBinary === true;
    const onChangesScopeChange = React.useCallback((changesScope: FileChangesScope) => patchFileView({ changesScope }), [patchFileView]);
    const offerWholeTurnRollback = useFileChangesRollback(isActive
        && (fileView.changesScope?.kind === 'turn' || (!fileView.changesScope && initialChanges?.kind === 'turnCheckpoint'))
        ? sessionAddress : null, scope.rootPath);
    // P5's Changes owner, once per page: the Changes body draws it, and its comparison arm is the only
    // whole-file Discard / Restore (View, Changes and the deleted tab alike; no HEAD-arm fallback, RV-B M8).
    const changesReview = useFileChangesReview({
        scope, sessionId: sessionId || null, filePath,
        liveDiff: diffContent, refreshLiveDiff: onRefresh, view: fileView, onChangesScopeChange,
        initialChanges,
        liveEntry: fileEntry,
        contentHash: fileContent?.contentHash ?? null,
        active: isActive && (displayMode === 'diff' || Boolean(fileEntry)),
        agentName: editorAttribution.agentName,
        hasUnsavedEdits: () => editorDirty,
        onReplacedUnsavedEdits: cancelEditingFile,
        offerWholeTurnRollback,
        workspaceRefId: props.workspaceRefId,
        getAskTargetContext,
        changedPaths,
    });
    // The peek names who made the change: the agent, and its turn when the marks come from one turn (ED3 "Claude, turn 3").
    const peekTurnNumber = changesReview.scopeKind === 'turn' ? changesReview.turnNumber : null;
    const peekAttribution = editorAttribution.agentName
        ? peekTurnNumber !== null ? `${editorAttribution.agentName}, ${t('hunkReview.turn', { turn: peekTurnNumber })}` : editorAttribution.agentName
        : null;
    const editorPeek = React.useMemo<FileEditorPanelProps['peek']>(() => ({
        dirty: editorDirty,
        attribution: peekAttribution,
        resolveChangeActions: (marker, context) => changesReview.controller.changeActionsForKey(marker.key,
            context.dirty ? { discardInDraft: () => context.revertInDraft(marker) } : undefined),
    }), [editorDirty, peekAttribution, changesReview.controller.changeActionsForKey]);
    // P7: one controller per File page; regions handed to this page (header fact, note, card, ⋯ commands).
    const codeIntelligence = useFilePageCodeIntelligence({
        scopeId: props.scopeId, scope, filePath, language,
        enabled: fileViewer.kind === 'code' && !fileContent?.isBinary && !fileContent?.partial && fileEntry?.kind !== 'deleted' && Boolean(fileContent),
        outlineEnabled: (fileViewer.kind === 'code' || fileViewer.kind === 'markdown') && !fileContent?.isBinary
            && !fileContent?.partial && fileEntry?.kind !== 'deleted' && Boolean(fileContent),
        active: isActive, liveValue, getUnsaved: () => editorState.readSnapshot().dirty, editorHandleRef,
        displayedText: isEditorSelected ? undefined : fileContent?.content,
        sessionId: sessionId || null, accountId: editorAccountScope?.accountId ?? null,
        machineName: checkoutReachability.machineName, machineUnreachable: checkoutReachability.unreachable,
        agentName: editorAttribution.agentName,
        revealLine: (line) => setJumpToAnchor(line === null ? null : { kind: 'line', filePath, line }),
    });
    bindCodeIntelligenceEditor.current = codeIntelligence.bindEditor;
    // Gutter marks come from the diff of the Changes scope the person selected (this turn, the session or
    // uncommitted), the same one the Changes body shows, seeded once per saved version and scope; the engine
    // then carries them through the person's edits (P4-R9).
    const changeMarkerSeedKey = JSON.stringify([fileContent?.contentHash ?? null, changesReview.changesScope, diffMode, editorResetKey]);
    const changeMarkerDiff = isEditingFile && typeof changesReview.unifiedDiff === 'string' && changesReview.unifiedDiff.length > 0
        ? changesReview.unifiedDiff : null;
    const changeMarkerDiffRef = React.useRef(changeMarkerDiff);
    changeMarkerDiffRef.current = changeMarkerDiff;
    const changeMarkerUnitsRef = React.useRef(changesReview.reviewUnits);
    changeMarkerUnitsRef.current = changesReview.reviewUnits;
    // Seeded per saved version: a refreshed diff for the same version does not move marks under the caret.
    const changeMarkers = React.useMemo(() => changeMarkerDiffRef.current
        ? { key: changeMarkerSeedKey, text: fileContent?.isBinary === false ? fileContent.content : '', items: buildEditorChangeMarkers(filePath, null, changeMarkerDiffRef.current, changeMarkerUnitsRef.current) } : undefined,
    [changeMarkerSeedKey, changeMarkerDiff !== null, filePath, fileContent?.content]);
    const changesFocusHunk = changesReview.controller.currentHunk;
    changesEditLineRef.current = changesFocusHunk ? (changesFocusHunk.rangeSide === 'new' ? changesFocusHunk.rangeStart : changesFocusHunk.newStart) : null;
    const menuContext: FileMenuContext = {
        machineReachable,
        unavailableReason,
        hasCachedContent: cachedContent !== null,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : desktopHostKind() === 'tauri' ? 'tauri' : 'web',
        partial: Boolean(fileContent?.partial),
        blame: fileView.blame === true,
        readBlame: scmSnapshot?.capabilities?.readBlame === true,
        toggleWrap: !isBinaryContent && displayMode !== 'markdown' ? () => patchFileView({ wrap: !effectiveWrapLines }) : undefined,
        showInfo: fileDetails.showInfo,
        chooseBackground: fileDetails.chooseBackground,
        copyContents: heldText !== null ? () => { void copyFileContent(); } : undefined,
        selectLines: scmWriteEnabled && (includeExcludeEnabled || virtualSelectionEnabled) && (lineSelectionCanStart || lineSelectionEnabled) && !commitSelectionModeActive
            ? () => onStartLineSelection() : undefined,
        revealInFiles: props.onRevealInFilesTree ? () => props.onRevealInFilesTree?.(filePath) : undefined,
        // Only a file the shown scope changed has Changes to open (the same predicate as Discard all changes).
        openChanges: changesReview.changed ? props.onOpenChanges : undefined,
        discardEdits: isEditingFile && editorDirty ? cancelEditingFile : undefined,
        toggleBlame: scmSnapshot?.capabilities?.readBlame === true ? () => patchFileView({ blame: !(fileView.blame === true) }) : undefined,
        changes: fileEntry?.kind === 'deleted' ? undefined : changesReview.menuChanges,
        copyPath: share.copyPath ? intent => share.copyPath?.({ absolute: intent?.altKey === true }) : undefined,
        copyAbsolutePath: share.copyAbsolutePath,
        copyLink: share.copyLink,
        mentionInComposer: share.mentionInComposer,
        saveAsArtifact: share.saveAsArtifact,
        download: fileEntry?.kind !== 'deleted' ? () => share.download() : undefined,
        shareFile: share.shareFile,
        openInDefaultApp: share.openInDefaultApp,
        commands: codeIntelligence.menuCommands,
    };
    const menuActions = buildFilePageMenuActions(menuContext, phonePage ? 'phone' : 'page',
        { details: fileDetails, wrapChecked: effectiveWrapLines, downloadBusy: share.busy });
    const pageEditControl = resolveFilePageEditControl({
        fileEditorEnabled: editorSurfaceEnabled && !isBinaryContent && fileEntry?.kind !== 'deleted' && headerModel.editUnavailableReason === null,
        isEditingFile: isEditorSelected,
        editor: editorHeader,
        onStart: () => handleStartEditingFile(),
        onSave: saveFileEdits,
        onCancel: cancelEditingFile,
        machineUnreachable: checkoutReachability.unreachable,
        // Only a mounted key row carries Save: both editor bodies (code and Markdown) mount it in Edit (B1-PE-03).
        keyRowCarriesSave: editorAccessory !== null && displayMode === 'file' && isEditorSelected,
    });
    // A PDF (lab FV5): the viewer owns its pages, scale and Find; the page remembers zoom and place per file
    // and shows the facts the viewer reports (page count, the phone's "3 of 14").
    const pdfBody = displayMode === 'file' && fileContent?.isBinary === true && fileViewer.kind === 'pdf';
    const [pdfPageInfo, setPdfPageInfo] = React.useState<Readonly<{ path: string; info: PdfPageInfo }> | null>(null);
    const shownPdfPageInfo = pdfPageInfo?.path === filePath ? pdfPageInfo.info : null;
    // The file whose Find bar is showing, as its owner reports it (the PDF viewer, or the text surface).
    const [findOpenPath, setFindOpenPath] = React.useState<string | null>(null);
    const reportFindOpen = React.useCallback((open: boolean) => setFindOpenPath(current => open ? filePath : current === filePath ? null : current), [filePath]);
    // The phone's bottom toolbar steps aside while something else holds the bottom edge: the editor's key row
    // (ED1p), the review bar in Changes (rvp P1) or Find's bar. The header then carries the view choice
    // and Done itself.
    const findHoldsBottom = findOpenPath === filePath;
    // A selection's bar (Ask · Comment · Copy) holds the bottom edge while it shows, as Find's bar does.
    const [selectionBarPath, setSelectionBarPath] = React.useState<string | null>(null);
    const reportSelectionBarShown = React.useCallback((shown: boolean) => setSelectionBarPath(current => shown ? filePath : current === filePath ? null : current), [filePath]);
    const toolbarSeat = phonePage && !isEditorSelected && !(displayMode === 'diff' && changesReview.controller.strip.total > 0);
    // After a phone Ask is sent, the working capsule holds the bottom edge until the turn settles.
    const askCapsuleHoldsBottom = usePhoneAskSheet()?.phase === 'working';
    const phoneToolbar = toolbarSeat && !findHoldsBottom && selectionBarPath !== filePath && !askCapsuleHoldsBottom;
    const pdfZoom = fileView.pdfZoom ?? 'fit-width';
    const pdfPosition = fileView.pdfPosition ?? null;
    const pdfControl = React.useMemo(() => ({
        zoom: pdfZoom,
        onZoomChange: (zoom: PdfZoom) => patchFileView({ pdfZoom: zoom }),
        position: pdfPosition,
        onPositionChange: (position: PdfViewPosition) => patchFileView({ pdfPosition: position }),
        onPageInfo: (info: PdfPageInfo) => setPdfPageInfo({ path: filePath, info }),
        onFindOpenChange: reportFindOpen,
        // Phones show the page in the bottom toolbar, so only one thing floats.
        showPagePill: !phonePage,
    }), [filePath, patchFileView, pdfPosition, pdfZoom, phonePage, reportFindOpen]);
    const pageFind = (displayMode === 'diff' ? typeof diffContent === 'string' : pdfBody || (typeof fileContent?.content === 'string' && !isBinaryContent))
        && headerModel.findAvailable !== false ? { onOpen: () => findRuntime.open(findSurfaceId) } : null;

    const previewTooLarge = error === t('files.fileTooLargeToPreview');
    const fatalError = Boolean(error) && !previewTooLarge && !diffContent && !fileContent;

    // One preview identity for the body and the Media stage it opens (P2 §3.3): the stage reuses these bytes.
    // SVG is held text on this page. Its stage consumes those same bytes through the preview owner,
    // rather than starting a second workspace download when the person expands the picture.
    const svgPreviewBytes = React.useMemo(() => fileViewer.kind === 'svg' && heldText !== null
        ? new TextEncoder().encode(heldText) : null, [fileViewer.kind, heldText]);
    const viewerPreviewIdentity = scope ? buildWorkspacePreviewIdentity(scope, filePath, fileContent?.binarySizeBytes,
        fileViewer.kind === 'svg' ? fileContent?.contentHash ?? null
            : JSON.stringify([snapshotSignature ?? lineSelectionFingerprint ?? null, fileContent?.binaryPreviewRevision ?? null])) : null;
    const viewerPreviewInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        source: svgPreviewBytes ? { kind: 'bytes', bytes: svgPreviewBytes, name: filePath }
            : scope ? { kind: 'workspace', scope, filePath } : { kind: 'uri', uri: '' },
        enabled: fileViewer.previewable && (svgPreviewBytes !== null || (Boolean(scope) && fileViewer.kind !== 'svg')),
        ...viewerPreviewIdentity,
        mimeType: fileViewer.mimeType,
        sizeBytes: fileContent?.binarySizeBytes ?? null,
        // Video admission is the transfer's own; every other kind uses the image-preview budget.
        ...(fileViewer.kind === 'video' ? { maxBytes: null } : {}),
    }), [scope, filePath, fileViewer.previewable, fileViewer.kind, fileViewer.mimeType, svgPreviewBytes, viewerPreviewIdentity?.cacheScopeId, viewerPreviewIdentity?.cacheKey, fileContent?.binarySizeBytes]);

    // Blame (P8 U5): a region the page places. Its run column rides the reading surface's leading lane in
    // View and Changes; the card and its one note sit beside it.
    const blameScope = React.useMemo(() => scope && editorAccountScope?.accountId ? { ...scope, accountId: editorAccountScope.accountId } : null,
        [editorAccountScope?.accountId, scope]);
    const blameContent = React.useMemo(() => fileContent && !fileContent.isBinary && !fileContent.partial
        && typeof fileContent.content === 'string' && fileContent.contentHash ? { text: fileContent.content, hash: fileContent.contentHash } : null,
    [fileContent]);
    const blameRegion = useFileBlameRegion({
        scope: blameScope, path: filePath, content: blameContent,
        enabled: fileView.blame === true,
        active: isActive,
        readBlame: scmSnapshot?.capabilities?.readBlame === true,
        sessionAddress, compact: phonePage,
        revision: scmSnapshot?.branch.headOid ?? scmSnapshot?.fetchedAt ?? null,
        refreshContent: refreshAll,
        editor: isEditingFile ? readyEditorHandle : null,
        onOpenCommit: (sha) => {
            const tab = sessionAddress ? createSessionCommitDetailsTab(sha) : createProjectCommitDetailsTab(sha);
            if (tab) pane.openDetailsTab(tab, { intent: 'pinned' });
        },
        onOpenTurn: sessionAddress ? (turn) => {
            if (turn.sessionId !== sessionAddress.sessionId) return;
            const session = selectHomeQualifiedSession(storage.getState(), turn.sessionId, sessionAddress.serverId, getActiveServerSnapshot().serverId);
            const seq = session?.sessionTurns?.turns.find((entry) => entry.turnId === turn.turnId)?.transcriptAnchors?.startUserMessageSeq;
            if (typeof seq !== 'number') return;
            approvalRouter.pushRetainingCurrent(buildScopedSessionRouteHref({ sessionId: turn.sessionId, serverId: sessionAddress.serverId, query: { jumpSeq: seq } }));
        } : undefined,
    });


    const isBinaryFile = fileContent?.isBinary === true;
    const [imageInfo, setImageInfo] = React.useState<Readonly<{ path: string; info: ImageWellInfo }> | null>(null);
    const onImageInfo = React.useCallback((info: ImageWellInfo) => setImageInfo({ path: filePath, info }), [filePath]);
    const [mediaInfo, setMediaInfo] = React.useState<Readonly<{ path: string; info: FilePageMediaInfo }> | null>(null);
    const onMediaInfo = React.useCallback((info: FilePageMediaInfo) => setMediaInfo({ path: filePath, info }), [filePath]);
    // The non-code body (image, SVG preview, PDF, media, binary identity) and its "View full screen" control.
    const showsViewerBody = (displayMode === 'file' && isBinaryFile) || (displayMode === 'markdown' && fileViewer.kind === 'svg' && heldText !== null);
    const viewerStageRef = React.useRef<FileViewerStageHandle | null>(null);
    const stageViewable = showsViewerBody && (fileViewer.kind === 'image' || fileViewer.kind === 'svg' || fileViewer.kind === 'pdf' || fileViewer.kind === 'video');
    const pageExpand = React.useMemo(() => stageViewable ? { onOpen: () => viewerStageRef.current?.open() } : null, [stageViewable]);
    const deleted = fileEntry?.kind === 'deleted';
    // The header's facts (details lab 2): how the file changed and by how much, or, for an unchanged
    // file, that nothing changed and how long it is; a partial view says which part it holds.
    const headerStatusLabel = fileEntry && !deleted ? resolveFileStatusLabel(fileEntry.kind) : null;
    const headerDiffStat = fileStatusForHeaderActions && !deleted
        ? { added: fileStatusForHeaderActions.linesAdded, removed: fileStatusForHeaderActions.linesRemoved }
        : null;
    const partial = fileContent?.partial ?? null;
    // Media: size and kind are written once, here in the meta row, never under the picture (lab FV4–FV6, delta 3).
    // A plain binary file says what it is on its identity card instead (FV2b).
    // An SVG's Preview is a picture too (FV4s): its facts are the picture's, not its XML's line count.
    const shownImageInfo = imageInfo?.path === filePath ? imageInfo.info : null;
    const shownMediaInfo = mediaInfo?.path === filePath ? mediaInfo.info : null;
    const svgPreviewShown = showsViewerBody && fileViewer.kind === 'svg';
    const mediaFacts = (isBinaryFile && fileViewer.kind !== 'binary') || svgPreviewShown ? resolveFilePageMediaFacts({
        viewer: fileViewer,
        sizeBytes: svgPreviewShown ? svgPreviewBytes?.byteLength ?? null : fileContent?.binarySizeBytes ?? null,
        image: shownImageInfo,
        // A PDF says how long it is once the viewer knows (FV5 "14 pages · 1.8 MB"); its mark already names the kind.
        pdfPageCount: pdfBody && shownPdfPageInfo ? shownPdfPageInfo.total : null,
        media: shownMediaInfo,
    }) : null;
    // Text with no language says so, so an unhighlighted body reads as a fact rather than a fault (lab FV2t).
    const plainTextFact = (language === null || language === 'text') && typeof fileContent?.content === 'string' && !isBinaryFile && !mediaFacts
        ? [t('files.pane.page.plainText')] : [];
    const headerSummaryFacts = partial
        ? [t('files.pane.page.partialFact', { slice: formatFilePageBytes(partial.length), size: formatFilePageBytes(partial.totalBytes) }), ...plainTextFact]
        : tooLarge && !fileContent ? [formatFilePageBytes(tooLarge.sizeBytes)]
        : mediaFacts ? mediaFacts
        : !fileEntry && !hasPendingDelta && !hasIncludedDelta && typeof fileContent?.content === 'string' && !isBinaryFile
            // "No changes" only once source control has answered; until then the line says only what is known.
            ? [...(scmSnapshot ? [t('detailsSurface.file.noChanges')] : []), t('detailsSurface.file.lines', { count: fileDetails.info.lineCount ?? 0 }), ...plainTextFact]
            : null;
    // Offline or behind: the content we hold stays at full strength under one line (FV1o, OR-1); editing
    // is never blocked. One cause, one line: a page above that already says it is not repeated here.
    const stale = Boolean(fileContent || diffContent !== null) && (checkoutReachability.unreachable || staleSince !== null);
    const freshnessLine = stale && !checkoutReachability.announced ? (
        <SurfaceFreshnessLine
            testID="file-details-freshness"
            asOf={staleSince ?? checkoutReachability.lastSeenAt}
            reason={checkoutReachability.unreachable ? unavailableReason : (error ?? unavailableReason)}
            action={{ label: t('common.retry'), onPress: () => { void retryMachineReachability(); onRefresh(); } }}
        />
    ) : null;
    const errorLine = error && !stale && !previewTooLarge && !fatalError ? (
        <SurfaceFreshnessLine
            testID="file-preview-unavailable-banner"
            tone="warning"
            reason={error}
            action={{ label: t('common.retry'), onPress: onRefresh }}
        />
    ) : null;
    const textKind = fileViewer.kind === 'markdown' || fileViewer.kind === 'code';
    const bodyLoading = !isEditingFile && !tooLarge && (
        (displayMode === 'diff' && !diffContent && (isDiffLoading || isLoading))
        || (displayMode !== 'diff' && !fileContent && !error && !previewTooLarge)
    );

    // The reading surface (find, comments, line selection) is one; Changes feeds it the scope's diff and rows.
    const renderFindPanel = (surface: FileChangesDiffSurface | null) => (
                    <>
                    {blameRegion.note ? <FileBlameNote note={blameRegion.note} /> : null}
                    {blameRegion.card}
                    <FileViewerFindSurface key={readingMemory.identity} surfaceId={findSurfaceId} active={isActive} focusRootRef={findFocusRoot}
                        initialFind={{ query: fileView.findQuery ?? '', open: fileView.findOpen === true }} onRememberFind={rememberFind}
                        onOpenChange={reportFindOpen}
                        content={{ path: filePath, mode: displayMode, text: displayMode === 'diff' ? (surface ? surface.unifiedDiff : diffContent) : fileContent?.isBinary ? null : fileContent?.content ?? null }}
                        findSeed={props.findSeed} onFindSeedConsumed={props.onFindSeedConsumed}>
                    {(find) => (
                    <FileContentPanel
                        readingMemory={displayMode === 'diff' ? undefined : readingMemory}
                        workspaceScope={scope}
                        find={find}
                        liveMoment={displayMode === 'file' ? liveMoment : null}
                        agentPresence={agentPresence}
                        intelligence={displayMode === 'file' || displayMode === 'diff' ? codeIntelligence.viewBinding : null}
                        codeBottomInset={codeIntelligence.phoneSheetInset}
                        theme={theme}
                        displayMode={displayMode}
                        sessionId={sessionId}
                        filePath={filePath}
                        diffContent={surface ? surface.unifiedDiff : diffContent}
                        hunks={surface?.hunks}
                        reviewUnits={surface?.reviewUnits}
                        reviewScrollToLineId={surface?.scrollToLineId}
                        diffLeadingContent={surface?.leadingContent}
                        fileContent={fileContent?.isBinary ? null : (fileContent?.content ?? null)}
                        language={language}
                        syntaxHighlighting={syntaxHighlighting}
                        selectedLineKeys={displayedSelectedLineKeys}
                        lineSelectionEnabled={effectiveLineSelectionEnabled && Boolean(scope)}
                        onToggleLine={toggleSelectedLine}
                        commentRangeRequest={commentRangeRequest}
                        rangeSelectionActive={rangeSelectionActive}
                        wrapLines={effectiveWrapLines}
                        showLineNumbers={showLineNumbers}
                        showPrefix={showLineNumbers}
                        reviewCommentsEnabled={reviewCommentsEnabled}
                        reviewCommentModeActive={reviewCommentModeActive}
                        reviewCommentDrafts={reviewCommentDrafts}
                        onUpsertReviewCommentDraft={reviewDraftHandlers.onUpsertReviewCommentDraft}
                        onDeleteReviewCommentDraft={reviewDraftHandlers.onDeleteReviewCommentDraft}
                        onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
                        jumpToAnchor={jumpToAnchor}
                        scrollTestID="file-details-scroll"
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={surface?.onScroll ? (event: Parameters<typeof scrollFades.onScroll>[0]) => {
                            scrollFades.onScroll(event);
                            surface.onScroll?.();
                        } : scrollFades.onScroll}
                        renderLeadingLane={blameRegion.renderLeadingLane}
                        emphasizedLines={blameRegion.emphasizedLines}
                    />
                    )}
                    </FileViewerFindSurface>
                    </>
    );

    // The read bodies (code view, Markdown preview) are one selection source for Ask (lab AS1).
    const readBody = (
        <View ref={readBodyRef} collapsable={false} style={{ flex: 1, minHeight: 0 }}>
            {renderFindPanel(null)}
            {Platform.OS === 'web' && heldText !== null && (displayMode === 'file' || displayMode === 'markdown') ? (
                <FileReadAskControls rootRef={readBodyRef} mode={displayMode === 'markdown' ? 'markdown' : 'code'}
                    scopeId={props.scopeId} scope={scope} filePath={filePath} text={heldText}
                    sessionId={sessionId || null} active={isActive && !reviewCommentModeActive}
                    onCommentRange={reviewCommentsEnabled && displayMode === 'file' ? onCommentSelectedRange : undefined}
                    onPhoneBarShownChange={reportSelectionBarShown} />
            ) : null}
        </View>
    );
    return (
        <View ref={findFocusRoot} style={[styles.container, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }]}>
            <View
                style={{
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                <FilePageHeader
                    // The Code page's own bar already names the file and its folders (until it hosts this header).
                    fileName={fileName}
                    filePath={filePath}
                    breadcrumbRoot={props.breadcrumbRoot}
                    onOpenFolder={props.onOpenFolder ?? (props.onRevealInFilesTree ? (folder) => props.onRevealInFilesTree?.(folder) : undefined)}
                    writing={deleted ? null : editorAttribution.writing}
                    attribution={deleted ? null : editorAttribution.agentName || attributionUpdatedAt !== null ? {
                        agentName: editorAttribution.agentName,
                        requesterName: editorAttribution.requesterName,
                        updatedAt: attributionUpdatedAt,
                    } : null}
                    deletion={deleted ? {
                        agentName: editorAttribution.agentName,
                        at: editorAttribution.updatedAt,
                        onRestore: changesReview.menuChanges.discardAll,
                    } : null}
                    statusPill={deleted ? { label: t('detailsSurface.file.statusDeleted') } : null}
                    modes={headerModel.modes}
                    find={pageFind}
                    expand={pageExpand}
                    accessory={pdfBody && !phonePage ? (
                        <PdfZoomMenu testID="file-pdf-zoom" zoom={pdfZoom} percent={null} onZoomChange={pdfControl.onZoomChange} />
                    ) : null}
                    edit={pageEditControl}
                    menuActions={menuActions}
                    // PDF Find only borrows the toolbar's edge, so the header stays as it was (lab FV5fp: ⋯ only).
                    toolbarBelow={toolbarSeat}
                    displayMode={displayMode}
                    onDisplayMode={onDisplayMode}
                    diffMode={diffMode}
                    onDiffMode={setDiffMode}
                    hasPendingDelta={hasPendingDelta}
                    hasIncludedDelta={hasIncludedDelta}
                    isUntrackedFile={fileEntry?.kind === 'untracked'}
                    scmWriteEnabled={scmWriteEnabled && Boolean(scope)}
                    includeExcludeEnabled={includeExcludeEnabled && Boolean(scope)}
                    virtualSelectionEnabled={virtualSelectionEnabled && Boolean(scope)}
                    isSelectedForCommit={isSelectedForCommit}
                    lineSelectionEnabled={lineSelectionEnabled && Boolean(scope)}
                    lineSelectionActive={commitSelectionModeActive}
                    rangeSelectionActive={rangeSelectionActive}
                    // Review comments land on lines: a picture or a PDF body has none to comment on.
                    reviewCommentsEnabled={reviewCommentsEnabled && !showsViewerBody}
                    commentModeActive={reviewCommentModeActive}
                    selectedLineCount={commitSelectionModeActive ? selectedLineKeys.size : 0}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={onStageFile}
                    onUnstageFile={onUnstageFile}
                    onApplySelectedLines={onApplySelectedLines}
                    onClearSelection={onClearSelection}
                    onStartRangeSelection={onStartRangeSelection}
                    onToggleCommentMode={onToggleReviewCommentMode}
                    fileEditorEnabled={editorSurfaceEnabled && !isBinaryFile && !deleted}
                    isEditingFile={isEditorSelected}
                    editor={editorHeader}
                    onStartEditingFile={handleStartEditingFile}
                    onCancelEditingFile={cancelEditingFile}
                    onSaveEditingFile={saveFileEdits}
                    statusLabel={headerStatusLabel}
                    diffStat={headerDiffStat}
                    summaryFacts={headerSummaryFacts}
                    providerFacts={codeIntelligence.headerFacts}
                    notice={(
                        <>
                            {freshnessLine}
                            {errorLine}
                            {codeIntelligence.notice}
                            <FileEditorNoticeLine editor={editorHeader} editing={isEditorSelected && !editorState.comparison}
                                reachability={checkoutReachability} agentName={editorAttribution.agentName}
                                onOpenApproval={openEditorApproval} />
                        </>
                    )}
                />
                {props.openableContentViewer && openableContentViewerEligible ? (
                    <WorkspaceFileOpenableContentViewerControls
                        sessionId={sessionId} workspaceRefId={props.workspaceRefId}
                        scope={scope}
                        filePath={filePath}
                        host={props.openableContentViewer}
                        builtinViewer={fileView.viewer}
                        isBinaryContent={fileContent?.isBinary ?? fileEntry?.stats.isBinary}
                        selectBuiltinViewer={selectBuiltinViewer}
                        builtinBodyRequired={isEditingFile || fileView.startEditing === true}
                        requestEdit={requestEditFromViewer}
                        onRevealInFilesTree={props.onRevealInFilesTree}
                    />
                ) : null}
            </View>

            <View
                style={{
                    flex: 1,
                    minHeight: 0,
                    position: 'relative',
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                {fatalError && !isEditingFile ? (
                    <FileErrorState filePath={filePath} error={error} onRetry={onRefresh} />
                ) : tooLarge && !fileContent && !isEditingFile && displayMode !== 'diff' ? (
                    <FileTooLargeState
                        sizeBytes={tooLarge.sizeBytes}
                        sliceBytes={tooLarge.maxPreviewBytes}
                        onShowFirst={() => patchFileView({ previewSlice: 'head' })}
                        onShowLast={() => patchFileView({ previewSlice: 'tail' })}
                        onDownload={() => { void share.download(); }}
                    />
                ) : previewTooLarge && !fileContent && !isEditingFile && displayMode !== 'diff' ? (
                    // Over the budget and not readable as text: the whole file goes through Download.
                    <FileTooLargeState sizeBytes={null} onDownload={() => { void share.download(); }} />
                ) : bodyLoading ? (
                    // Nothing of this file is held yet and its machine isn't answering: say what it waits for.
                    checkoutReachability.unreachable ? <CheckoutUnreachableState reachability={checkoutReachability} testID="file-details-unreachable" />
                        : textKind && displayMode !== 'markdown' ? (
                            <View style={{ flex: 1 }}>
                                <FileReadingLine machineName={checkoutReachability.machineName} />
                                <FileCodeSkeleton active={isActive} />
                            </View>
                        ) : <FileLoadingState filePath={filePath} />
                ) : displayMode === 'file' && isEditorSelected && isMarkdownFile ? (
                    <FileMarkdownEditorPanel
                        peek={editorPeek}
                        {...codeGeometry}
                        value={editorSeedText} resetKey={String(editorResetKey)} filePath={filePath} language={language}
                        onChange={onEditorChange} editorRef={editorHandleRef} liveValue={liveValue}
                        findSurfaceId={findSurfaceId} active={isActive} focusRootRef={findFocusRoot}
                        findSeed={props.findSeed} onFindSeedConsumed={props.onFindSeedConsumed}
                        changeMarkers={changeMarkers}
                        accessory={editorAccessory}
                        wrapLines={effectiveWrapLines} showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                        onReady={onEditorReady} initialLine={initialLine}
                    />
                ) : displayMode === 'file' && isEditorSelected ? (
                    <>
                    {codeEditorWarming ? readBody : null}
                    <View testID={codeEditorWarming ? 'file-details-editor-warming' : undefined} pointerEvents={codeEditorWarming ? 'none' : 'auto'}
                        aria-hidden={codeEditorWarming || undefined}
                        style={codeEditorWarming ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 } : { flex: 1, minHeight: 0 }}>
                    <FileEditorPanel
                        {...codeGeometry}
                        onReady={onCodeEditorReady}
                        initialLine={initialLine}
                        surfaceId={findSurfaceId}
                        active={isActive}
                        filePath={filePath}
                        focusRootRef={findFocusRoot}
                        findSeed={props.findSeed}
                        onFindSeedConsumed={props.onFindSeedConsumed}
                        theme={theme}
                        resetKey={String(editorResetKey)}
                        editorRef={editorHandleRef}
                        value={editorSeedText}
                        language={language}
                        onChange={onEditorChange}
                        wrapLines={effectiveWrapLines}
                        showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                        changeMarkers={changeMarkers}
                        accessory={editorAccessory}
                        peek={editorPeek}
                        inlineComment={editorComment.comment}
                    />
                    <FileEditorAgentPresence handle={readyEditorHandle} presence={agentPresence} />
                    {scope ? (
                        <FileEditorAskControls handle={readyEditorHandle} scopeId={props.scopeId} scope={scope} filePath={filePath}
                            savedText={fileContent?.isBinary ? undefined : fileContent?.content} sessionId={sessionId || null} active={isActive}
                            onCommentSelection={editorComment.onCommentSelection} />
                    ) : null}
                    {/* Blame in Edit: the gutter markers open the same run card (a portal popover at the run's line). */}
                    {blameRegion.card}
                    </View>
                    </>
                ) : showsViewerBody ? (
                    <FileViewerBody
                        viewer={fileViewer}
                        title={filePath.split(/[\\/]/).at(-1) || filePath}
                        source={viewerPreviewInput}
                        svgText={fileViewer.kind === 'svg' ? heldText : null}
                        sizeBytes={fileContent?.binarySizeBytes ?? null}
                        isActive={isActive}
                        findSurfaceId={findSurfaceId}
                        onDownload={() => { void share.download(); }}
                        onOpenAsText={openAsText}
                        {...(share.openInDefaultApp ? { onOpenInDefaultApp: share.openInDefaultApp } : {})}
                        onImageInfo={onImageInfo}
                        onMediaInfo={onMediaInfo}
                        stageRef={viewerStageRef}
                        {...(fileViewer.kind === 'pdf' ? { pdf: pdfControl } : {})}
                        testID="file-viewer-body"
                    />
                ) : displayMode === 'diff' && scope ? (
                    <FileChangesSection review={changesReview} scope={scope} filePath={filePath}
                        keyboardActive={isActive} liveChangeKind={fileEntry?.kind ?? null}
                        ask={{ scopeId: props.scopeId, sessionId: sessionId || null, active: isActive,
                            onCommentRange: reviewCommentsEnabled ? onCommentSelectedRange : undefined,
                            onPhoneBarShownChange: reportSelectionBarShown }}>
                        {(surface) => renderFindPanel(surface)}
                    </FileChangesSection>
                ) : readBody}

                {displayMode === 'file' && isEditorSelected && editorState.comparison ? (
                    // Compare covers the editor without unmounting it, so the engine keeps its buffer, caret and undo.
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                        <FileEditorCompareBody comparison={editorState.comparison} agentName={editorAttribution.agentName}
                            filePath={filePath} showLineNumbers={showLineNumbers}
                            onUsePlaceMine={editorState.usePlaceMine} onUsePlaceTheirs={editorState.usePlaceTheirs}
                            onUseAllMine={editorState.useAllMine} onUseAllTheirs={editorState.useAllTheirs}
                            onBackToEditing={editorState.backToEditing} />
                    </View>
                ) : null}
                {isEditorSelected ? null : (
                    <>
                        <ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={scrollFades.visibility} />
                        <ScrollEdgeIndicators
                            edges={scrollFades.visibility}
                            color={theme.colors.text.secondary}
                            size={14}
                            opacity={0.35}
                        />
                    </>
                )}
                {/* Rename / quick-fix review takes this body region like Changes do (P7 U7). */}
                {codeIntelligence.editSetLayer}
            </View>
            {partial && displayMode !== 'diff' ? (
                <FilePartialFooter slice={partial.slice} sliceBytes={partial.length} totalBytes={partial.totalBytes}
                    onDownload={() => { void share.download(); }} />
            ) : null}
            {codeIntelligence.layer}
            {phoneToolbar ? (
                <FilePageToolbar
                    modes={headerModel.modes}
                    displayMode={displayMode}
                    onDisplayMode={onDisplayMode}
                    find={pageFind}
                    edit={pageEditControl}
                    accessory={pdfBody && shownPdfPageInfo ? (
                        <Text testID="file-page-toolbar-pdf-page" variant="body" style={[{ color: theme.colors.text.primary, paddingHorizontal: theme.space.s8 }, Typography.tabular()]}>
                            {t('files.viewer.stageCounter', { current: shownPdfPageInfo.page, total: shownPdfPageInfo.total })}
                        </Text>
                    ) : null}
                    overPicture={showsViewerBody}
                    bottomInset={safeAreaInsets.bottom}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
}));
