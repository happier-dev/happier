import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DetailsTabGroupPanel } from '@/components/appShell/panes/details/workspace/DetailsTabGroupPanel';
import type { DetailsWorkspaceGroupView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsDiffSummaryRow } from '@/components/appShell/panes/details/header/DetailsDiffSummaryRow';
import { REVIEW_TRAY_RESERVED_PX, ReviewDraftSummary } from '@/components/sessions/reviews/comments/ReviewDraftSummary';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { FileActionToolbar } from '@/components/workspaces/files/file/FileActionToolbar';
import { ScmCommitDetailsHeader } from '@/components/workspaces/scm/history/ScmCommitDetailsHeader';
import { ScmStashDetailsCore } from '@/components/workspaces/scm/stash/ScmStashDetailsCore';
import type { ScmStashDetailsAdapter } from '@/components/workspaces/scm/stash/scmStashAdapter';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { showWorkspaceFileEditorComparison } from '@/components/workspaces/files/details/workspaceFileDetails/WorkspaceFileEditorComparison';
import { ScmCommitSelectionCheckGlyph } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { IconButton } from '@/components/ui/buttons/IconButton';

/**
 * Dev-only specimen of the Details chrome and kinds (details lab 2, frames F1/F2/F3, CM, SZ, R1/SG,
 * ST) drawn through the real owners at static props, so the lab can be compared side by side without
 * a reachable Home. Content is the lab's illustration (the SettingsModal change), not product data.
 */
const SETTINGS_MODAL_DIFF = [
    'diff --git a/apps/ui/sources/components/settings/SettingsModal.tsx b/apps/ui/sources/components/settings/SettingsModal.tsx',
    '--- a/apps/ui/sources/components/settings/SettingsModal.tsx',
    '+++ b/apps/ui/sources/components/settings/SettingsModal.tsx',
    '@@ -1,6 +1,7 @@',
    " import * as React from 'react';",
    " import { useWindowDimensions } from 'react-native';",
    " import { Modal } from '@/components/ui/modal/Modal';",
    " import { SettingsBody } from './SettingsBody';",
    "+import { useSettingsRouteKey } from './useSettingsRouteKey';",
    " import type { SettingsRoute } from './settingsRoutes';",
    ' ',
    '@@ -18,9 +19,10 @@ export function SettingsModal({ route, onClose }: Props) {',
    ' export function SettingsModal({ route, onClose }: Props) {',
    '     const { width } = useWindowDimensions();',
    '-    const key = `${route.path}:${width}`;',
    '+    // Keyed by route only: a resize must not remount the modal.',
    '+    const key = useSettingsRouteKey(route);',
    '     return (',
    '-        <Modal key={key} onDismiss={onClose}>',
    '+        <Modal key={key} compact={width < 600} onDismiss={onClose}>',
    '             <SettingsBody route={route} />',
    '         </Modal>',
    '     );',
    ' }',
    '',
].join('\n');

const HOOK_TEXT = [
    "import type { SettingsRoute } from './settingsRoutes';",
    '',
    '/**',
    ' * A stable key for the settings modal. It changes when the route changes,',
    ' * never when the window resizes, so the modal keeps its draft and scroll.',
    ' */',
    'export function useSettingsRouteKey(route: SettingsRoute): string {',
    '    return React.useMemo(() => {',
    '        switch (route.kind) {',
    "            case 'section':",
    '                return `section:${route.section}`;',
    "            case 'search':",
    "                return `search:${route.query ?? ''}`;",
    '            default:',
    "                return 'root';",
    '        }',
    '    }, [route]);',
    '}',
].join('\n');

const HOOK_LINES = buildCodeLinesFromFile({ text: HOOK_TEXT });
const NOOP = () => {};
const PANE: AppPaneScopeApi = new Proxy({} as AppPaneScopeApi, { get: () => NOOP });

function group(tabs: DetailsWorkspaceGroupView['tabs'], activeTabKey: string | null): DetailsWorkspaceGroupView {
    return { id: 'specimen', tabKeys: tabs.map((tab) => tab.key), activeTabKey, tabs, isFocused: true };
}

const FILE_TAB = { key: 'file:SettingsModal.tsx', kind: 'file', title: 'SettingsModal.tsx', isPinned: false, isPreview: true, resource: { kind: 'file', path: 'SettingsModal.tsx' } } as const;
const HOOK_TAB = { key: 'file:useSettingsRouteKey.ts', kind: 'file', title: 'useSettingsRouteKey.ts', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'useSettingsRouteKey.ts' } } as const;
const REVIEW_TAB = { key: 'scmReview:working', kind: 'scmReview', title: t('detailsSurface.review.title'), isPinned: true, isPreview: false, resource: { kind: 'scmReview', scope: 'working' } } as const;
const COMMIT_TAB = { key: 'commit:4f2a91c', kind: 'commit', title: 'Key the settings modal…', isPinned: false, isPreview: false, resource: { kind: 'commit', sha: '4f2a91c' } } as const;
const STASH_TAB = { key: 'scmStash', kind: 'scmStash', title: t('files.stash.detailsTitle'), isPinned: false, isPreview: false, resource: { kind: 'scmStash' } } as const;

const REVIEW_FILES: ScmFileStatus[] = [
    { fileName: 'SettingsModal.tsx', filePath: 'apps/ui/…/settings', fullPath: 'apps/ui/sources/components/settings/SettingsModal.tsx', status: 'modified', isIncluded: false, linesAdded: 4, linesRemoved: 2 },
    { fileName: 'useSettingsRouteKey.ts', filePath: 'apps/ui/…/settings', fullPath: 'apps/ui/sources/components/settings/useSettingsRouteKey.ts', status: 'added', isIncluded: false, linesAdded: 21, linesRemoved: 0 },
    { fileName: 'SettingsModal.test.tsx', filePath: 'apps/ui/…/settings', fullPath: 'apps/ui/sources/components/settings/SettingsModal.test.tsx', status: 'modified', isIncluded: false, linesAdded: 38, linesRemoved: 1 },
    { fileName: 'settings.tsx', filePath: 'apps/ui/…/app/(app)', fullPath: 'apps/ui/sources/app/(app)/settings.tsx', status: 'modified', isIncluded: false, linesAdded: 2, linesRemoved: 2 },
];
const NO_SESSION_ATTRIBUTION: SessionAttributedFile[] = [];
const SPECIMEN_REVIEW_HEADER = {
    isSelectedForCommit: (file: ScmFileStatus) => REVIEW_FILES.slice(0, 3).some((entry) => entry.fullPath === file.fullPath),
};

const REVIEW_SNAPSHOT: ScmWorkingSnapshot = {
    projectKey: 'details-specimen',
    fetchedAt: Date.now(),
    repo: { isRepo: true, rootPath: '/details-specimen', backendId: 'git', mode: '.git' },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [],
    totals: {
        includedFiles: 0, pendingFiles: 4, untrackedFiles: 0,
        includedAdded: 0, includedRemoved: 0, pendingAdded: 65, pendingRemoved: 5,
    },
};

const DRAFTS: readonly ReviewCommentDraft[] = [
    {
        id: 'c1', filePath: REVIEW_FILES[0].fullPath, source: 'diff', anchor: { kind: 'diffLine', startLine: 22, side: 'after', oldLine: null, newLine: 22 },
        snapshot: { selectedLines: [], beforeContext: [], afterContext: [] },
        body: 'Name the hook after what it guarantees — `useStableSettingsKey`? “Route key” reads like a URL.', createdAt: 1, includeInPrompt: true,
    },
    {
        id: 'c2', filePath: REVIEW_FILES[0].fullPath, source: 'diff', anchor: { kind: 'diffLine', startLine: 24, side: 'after', oldLine: null, newLine: 24 },
        snapshot: { selectedLines: [], beforeContext: [], afterContext: [] },
        body: 'Is 600 the breakpoint the phone sheet uses too? Take it from `useModalLayout` instead of a literal.', createdAt: 2, includeInPrompt: true,
    },
] as unknown as readonly ReviewCommentDraft[];

const STASH_ADAPTER: ScmStashDetailsAdapter = {
    list: async () => ({
        success: true,
        stashes: [
            { stashRef: 'stash@{0}', kind: 'branch', branch: 'v0.3', createdAt: Date.now() - 2 * 3_600_000 },
            { stashRef: 'stash@{1}', kind: 'transient', message: 'Before rolling back to checkpoint 3', createdAt: Date.now() - 26 * 3_600_000 },
            { stashRef: 'stash@{2}', kind: 'unmanaged', message: 'WIP on main: docs search', createdAt: Date.now() - 3 * 86_400_000 },
        ],
        totalCount: 3,
    }),
    show: async () => ({ success: true, diff: SETTINGS_MODAL_DIFF, truncated: false }),
    pop: async () => ({ success: true }),
    drop: async () => ({ success: true }),
    apply: async () => ({ success: true }),
};

function FileFrame(props: Readonly<{ editing?: boolean }>) {
    const { theme } = useUnistyles();
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting('useSettingsRouteKey.ts');
    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <FileActionToolbar
                theme={theme}
                fileName={props.editing ? 'useSettingsRouteKey.ts' : 'SettingsModal.tsx'}
                filePathDir="apps/ui/…/settings"
                displayMode={props.editing ? 'file' : 'diff'}
                onDisplayMode={NOOP}
                showDiffToggle={!props.editing}
                showFileToggle
                showWrapLinesToggle
                diffMode="pending"
                onDiffMode={NOOP}
                hasPendingDelta={!props.editing}
                hasIncludedDelta={false}
                scmWriteEnabled
                includeExcludeEnabled
                virtualSelectionEnabled={false}
                isSelectedForCommit={false}
                lineSelectionEnabled={false}
                reviewCommentsEnabled
                onToggleCommentMode={NOOP}
                selectedLineCount={0}
                isApplyingStage={false}
                inFlightScmOperation={null}
                onStageFile={NOOP}
                onUnstageFile={NOOP}
                onApplySelectedLines={NOOP}
                onClearSelection={NOOP}
                fileEditorEnabled
                isEditingFile={props.editing === true}
                fileEditorDirty={props.editing === true}
                onStartEditingFile={NOOP}
                onCancelEditingFile={NOOP}
                onSaveEditingFile={NOOP}
                statusLabel={props.editing ? null : t('detailsSurface.file.statusModified')}
                diffStat={props.editing ? null : { added: 4, removed: 2 }}
                notice={props.editing ? (
                    <SurfaceFreshnessLine tone="warning" reason={t('files.fileChangedExternally')} action={{ label: t('detailsSurface.file.compare'), onPress: () => showWorkspaceFileEditorComparison({ oldText: HOOK_TEXT.replace('never when the window resizes', 'only when the route changes'), newText: HOOK_TEXT, filePath: 'useSettingsRouteKey.ts' }) }} />
                ) : null}
            />
            <View style={{ flex: 1, minHeight: 0 }}>
                {props.editing ? (
                    <CodeLinesView lines={HOOK_LINES} showLineNumbers wrapLines={false} syntaxHighlighting={syntaxHighlighting} />
                ) : (
                    <DiffViewer mode="unified" unifiedDiff={SETTINGS_MODAL_DIFF} filePath="apps/ui/sources/components/settings/SettingsModal.tsx" showLineNumbers showPrefix wrapLines={false} />
                )}
            </View>
        </View>
    );
}

function CommitFrame() {
    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <ScmCommitDetailsHeader
                sha="4f2a91c8e0d1"
                commit={{
                    status: 'ready',
                    entry: {
                        sha: '4f2a91c8e0d1',
                        shortSha: '4f2a91c',
                        authorName: 'Leeroy Brun',
                        authorEmail: 'leeroy@example.test',
                        timestamp: Date.now() - 20 * 60_000,
                        subject: 'Key the settings modal by route, not window width',
                        body: 'Resizing the window remounted SettingsModal because its key included the width, which threw away the draft and the scroll position. Key it by route through useSettingsRouteKey and cover resizing in the modal test.',
                    },
                }}
                actions={<><DiffPresentationStyleToggleButton presentation="segmented" /><WrapLinesToggleButton /></>}
            />
            <DetailsDiffSummaryRow label={t('detailsSurface.history.filesChanged', { count: 4 })} added={65} removed={5} />
            <View style={{ flex: 1, minHeight: 0 }}>
                <DiffViewer mode="unified" unifiedDiff={SETTINGS_MODAL_DIFF} filePath="apps/ui/sources/components/settings/SettingsModal.tsx" showLineNumbers showPrefix wrapLines={false} />
            </View>
        </View>
    );
}

/** Per-file fixture diffs for the Review stream (fetched through Review's own diff-loading owner). */
function fixtureDiff(path: string): string {
    if (path.endsWith('SettingsModal.tsx')) return SETTINGS_MODAL_DIFF;
    const added = path.endsWith('useSettingsRouteKey.ts');
    const body = added
        ? HOOK_TEXT.split('\n').map((line) => `+${line}`)
        : [' // settings', `-const legacy = true;`, `+const legacy = false;`, ' export {};'];
    return [
        `diff --git a/${path} b/${path}`,
        `--- ${added ? '/dev/null' : `a/${path}`}`,
        `+++ b/${path}`,
        added ? `@@ -0,0 +1,${body.length} @@` : '@@ -1,3 +1,3 @@',
        ...body,
        '',
    ].join('\n');
}

const fetchSpecimenReviewDiff: ScmReviewUnifiedDiffFetcher = async ({ path }) => ({
    success: true,
    diff: fixtureDiff(path),
});


const SPECIMEN_ASK = { text: 'Address these, then run the settings tests again.', onChangeText: NOOP, onSend: NOOP, sending: false };
const ONE_DRAFT = DRAFTS.slice(0, 1);

/**
 * R1/SG: the real Review — its header, the file list first, then the diff stream through Review's own
 * diff renderer, inline draft comments under their lines, and the tray at the foot.
 */
function ReviewFrame(props: Readonly<{ open?: boolean }>) {
    const { theme } = useUnistyles();
    const [drafts, setDrafts] = React.useState<readonly ReviewCommentDraft[]>(() => props.open ? DRAFTS : ONE_DRAFT);
    // Fixture-local state follows the canonical store's id-preserving upsert/delete semantics,
    // without writing lab comments into a real session or Account.
    const upsertDraft = React.useCallback((draft: ReviewCommentDraft) => {
        setDrafts((existing) => existing.some((item) => item.id === draft.id)
            ? existing.map((item) => item.id === draft.id ? draft : item)
            : [...existing, draft]);
    }, []);
    const deleteDraft = React.useCallback((id: string) => setDrafts((existing) => existing.filter((draft) => draft.id !== id)), []);
    return (
        <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <ChangedFilesReview
                detailsHeader={SPECIMEN_REVIEW_HEADER}
                bottomInsetPx={REVIEW_TRAY_RESERVED_PX}
                theme={theme}
                sessionId="details-specimen"
                snapshot={REVIEW_SNAPSHOT}
                changedFilesViewMode="repository"
                allRepositoryChangedFiles={REVIEW_FILES}
                sessionAttributedFiles={NO_SESSION_ATTRIBUTION}
                repositoryOnlyFiles={REVIEW_FILES}
                maxFiles={25}
                maxChangedLines={2000}
                onFilePress={NOOP}
                reviewCommentsEnabled
                reviewCommentDrafts={drafts}
                onUpsertReviewCommentDraft={upsertDraft}
                onDeleteReviewCommentDraft={deleteDraft}
                renderFileActions={(file) => <IconButton variant="plain" size={24} onPress={NOOP} accessibilityRole="checkbox" checked={SPECIMEN_REVIEW_HEADER.isSelectedForCommit(file)} accessibilityLabel={t('files.commitSelection.addToCommit')} icon={<ScmCommitSelectionCheckGlyph state={SPECIMEN_REVIEW_HEADER.isSelectedForCommit(file) ? 'checked' : 'unchecked'} />} />}
                fetchUnifiedDiffForPath={fetchSpecimenReviewDiff}
            />
            <ReviewDraftSummary enabled drafts={drafts} onGoToComposer={NOOP} onDetachDraft={(draft) => upsertDraft({ ...draft, includeInPrompt: false })} composer={props.open ? SPECIMEN_ASK : null} />
        </View>
    );
}

const FRAMES: ReadonlyArray<Readonly<{ id: string; title: string; render: () => React.ReactNode }>> = [

    {
        id: 'F1',
        title: 'F1 · file diff, docked',
        render: () => (
            <DetailsTabGroupPanel pane={PANE} group={group([FILE_TAB, REVIEW_TAB], FILE_TAB.key)} renderTabContent={() => <FileFrame />} />
        ),
    },
    {
        id: 'F3',
        title: 'F3 · file edit',
        render: () => (
            <DetailsTabGroupPanel pane={PANE} group={group([HOOK_TAB, REVIEW_TAB], HOOK_TAB.key)} renderTabContent={() => <FileFrame editing />} />
        ),
    },
    {
        id: 'R1',
        title: 'R1 · Review',
        render: () => (
            <DetailsTabGroupPanel pane={PANE} group={group([REVIEW_TAB, FILE_TAB], REVIEW_TAB.key)} renderTabContent={() => <ReviewFrame />} />
        ),
    },
    {
        id: 'SG',
        title: 'SG · comments tray (open)',
        render: () => (
            <DetailsTabGroupPanel pane={PANE} group={group([REVIEW_TAB, FILE_TAB], REVIEW_TAB.key)} renderTabContent={() => <ReviewFrame open />} />
        ),
    },
    {
        id: 'CM',
        title: 'CM · commit',
        render: () => (
            <DetailsTabGroupPanel pane={PANE} group={group([COMMIT_TAB, REVIEW_TAB], COMMIT_TAB.key)} renderTabContent={() => <CommitFrame />} />
        ),
    },
    {
        id: 'SZ',
        title: 'SZ · stash',
        render: () => (
            <DetailsTabGroupPanel
                pane={PANE}
                group={group([STASH_TAB, REVIEW_TAB], STASH_TAB.key)}
                renderTabContent={() => <ScmStashDetailsCore adapter={STASH_ADAPTER} scopeResetKey="specimen" folderLabel="happier" applyButtonTestId="specimen-stash-apply" />}
            />
        ),
    },
    {
        id: 'ST',
        title: 'ST · nothing open (invites Review)',
        render: () => (
            <DetailsTabGroupPanel
                pane={PANE}
                group={group([], null)}
                renderTabContent={() => null}
                renderHeaderActions={() => <>
                    <IconButton variant="plain" size={24} iconName="arrows-out" onPress={NOOP} accessibilityLabel={t('session.detailsPanel.enterFocusModeA11y')} />
                    <IconButton variant="plain" size={24} iconName="x" onPress={PANE.closeDetails} accessibilityLabel={t('common.close')} />
                </>}
                renderEmptyState={() => (
                    <SurfaceStateCard
                        kind="empty"
                        iconName="git-diff"
                        title={t('detailsSurface.chrome.emptyTitle')}
                        reason={t('detailsSurface.chrome.reviewChangesReason', { count: 4 })}
                        action={{ label: t('detailsSurface.chrome.reviewChanges', { count: 4 }), onPress: NOOP }}
                        secondaryAction={{ label: t('detailsSurface.chrome.browseFiles'), onPress: NOOP }}
                        note={t('detailsSurface.chrome.previewHint')}
                    />
                )}
            />
        ),
    },
];

export function DetailsSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    const frames = props.only ? FRAMES.filter((frame) => frame.id === props.only) : FRAMES;
    const grid = (
            <View style={styles.grid}>
                {frames.map((frame) => (
                    <View key={frame.id} testID={`details-specimen-${frame.id}`} style={props.phone ? styles.framePhone : styles.frame}>
                        {props.only ? null : <Text style={styles.caption}>{frame.title}</Text>}
                        <View style={styles.frameBody}>{frame.render()}</View>
                    </View>
                ))}
            </View>
    );
    // One frame renders on a plain page: a virtualized list (Review's stream) must own its scrolling,
    // as it does in the Details pane, not sit inside the board's ScrollView.
    const content = props.only
        ? <View style={[styles.root, styles.content]}>{grid}</View>
        : <ScrollView style={styles.root} contentContainerStyle={styles.content}>{grid}</ScrollView>;
    return props.phone ? <SurfaceStateSizeProvider size="phone">{content}</SurfaceStateSizeProvider> : content;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: 16, gap: 24 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.secondary, padding: 8 },
    frame: {
        width: 600,
        height: 880,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    framePhone: {
        width: '100%',
        height: 780,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
    },
    frameBody: { flex: 1, minHeight: 0 },
}));
