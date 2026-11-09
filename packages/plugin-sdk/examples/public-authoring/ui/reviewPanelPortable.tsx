import * as React from 'react';

import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { actionInputOptionValueKey, readInputTypePickerLaunchInput } from '@happier-dev/plugin-sdk/actions';
import {
    Action,
    Button,
    Card,
    CodeBlock,
    Collection,
    DetailsPaneOpenAsPageButton,
    defineHappierScene,
    defineHappierSceneProp,
    defineUiSurface,
    EmptyState,
    ErrorState,
    HappierFindHighlightedText,
    HappierPressable,
    HappierPromptPickerPreview,
    HappierPromptPickerRow,
    HappierText,
    Icon,
    LoadingState,
    matchFindText,
    Row,
    Screen,
    ScrollArea,
    SetupBlockGrid,
    SetupBlockTile,
    SetupSteps,
    Stack,
    Status,
    StatusCell,
    SurfaceState,
    Text,
    TextField,
    useLivePluginResource,
    useHappierCollection,
    usePluginTheme,
    useSurfaceContext,
    VoiceMarkArt,
    WidgetSurface,
    type HappierPromptPickerColors,
    type HappierPromptPickerHost,
    type HappierPromptPickerMetaPart,
} from '@happier-dev/plugin-ui';

import {
    REVIEW_OPENABLE_CONTENT_VIEW_ID,
    readReviewOpenableContent,
    readReviewOpenableContentReference,
    type ReviewOpenableContentResult,
} from './reviewOpenableContent.js';
import { PROJECT_COMPANION_ACTIVITY_CURRENT_UI_CONTEXT } from './reviewClientActions.js';
import { SESSION_SKILL_REFERENCE_VIEW_ID, SessionSkillReference } from './sessionSkill.js';

/**
 * This plugin's empty-state scene, composed from Happier's scene parts: the desk at golden hour, the
 * plugin's own prop (a review card waiting) as the focal prop, and the built-in mug beside it. The host
 * draws it in the scene's ink, size and motion.
 */
const REVIEW_CARD = defineHappierSceneProp({
    name: 'example.review-card',
    marks: [
        { shape: 'rect', x: -8, y: -12, width: 16, height: 12, radius: 2 },
        { shape: 'path', d: 'M-5 -8h10M-5 -4.5h6', tone: 'faint' },
    ],
});
const NO_REVIEW_STATUS_SCENE = defineHappierScene({
    name: 'example.no-review-status',
    horizon: 'desk',
    moment: 'golden',
    props: [{ prop: REVIEW_CARD, x: 56 }, { prop: 'mug', x: 80 }],
});

const REVIEW_PANEL_VIEW_ID = 'review-panel';
const REVIEW_SESSION_STATUS_VIEW_ID = 'review-session-status-details';
const PROJECT_COMPANION_ACTIVITY_VIEW_ID = 'project-companion-activity-log';
const PROJECT_COMPANION_PROJECT_ACTIVITY_VIEW_ID = 'project-companion-project-activity-log';
const REVIEW_PROJECT_PAGE_VIEW_ID = 'review-project-page';
const PROJECT_REVIEW_ENTRIES = [{ id: 'identity', title: 'Accepted Project identity' }] as const;
const projectReviewEntryKey = (entry: (typeof PROJECT_REVIEW_ENTRIES)[number]) => entry.id;
const PROJECT_REVIEW_ANATOMY = {
    glyph: () => null,
    title: (entry: (typeof PROJECT_REVIEW_ENTRIES)[number]) => entry.title,
    accessibilityLabel: (entry: (typeof PROJECT_REVIEW_ENTRIES)[number]) => entry.title,
    testID: () => 'review.project.identity',
    columnTitles: { title: 'Review' },
};

/** One controlled page model survives its host pane, full page and return presentations. */
function ReviewProjectPage({ context }: Readonly<{ context: RenderContext }>) {
    const surface = useSurfaceContext();
    const [subPath, setSubPath] = React.useState(context.subPath ?? '');
    const [note, setNote] = React.useState('');
    const navigate = React.useCallback(async (subPath: string, backLocation: string) => {
        const settled = await context.hostApi.replacePageLocation(subPath, { backLocation });
        setSubPath(settled.subPath);
    }, [context.hostApi]);
    React.useEffect(() => {
        const subPath = context.subPath ?? '';
        setSubPath(subPath);
        // A direct/reloaded detail declares the same local Back participant as an in-page open.
        if (subPath === 'identity' || subPath === 'identity/page') {
            void navigate(subPath, subPath === 'identity/page' ? 'identity' : '');
        }
    }, [context.subPath, navigate]);
    const open = React.useCallback((key: string | null) => {
        void navigate(key === 'identity' ? 'identity' : '', '');
    }, [navigate]);
    const model = useHappierCollection({ items: PROJECT_REVIEW_ENTRIES, keyOf: projectReviewEntryKey,
        openKey: subPath === 'identity' ? 'identity' : null, onOpenChange: open });
    if (surface.target.kind !== 'project') {
        return <ErrorState title="Review needs a Project" description="Open this page from an accepted Project." />;
    }
    const detail = <Stack gap="small">
        <Text testID="review.project.key" value={surface.target.projectKey} selectable />
        <Text testID="review.project.repository" value={surface.target.repository?.kind ?? 'Repository identity unavailable'} tone="secondary" />
        <TextField testID="review.project.note" label="Review note" value={note} onChange={setNote} />
    </Stack>;
    if (subPath === 'identity/page') {
        return <ReviewFrame accessibilityLabel="Project review">
            {detail}
            <Button testID="review.project.return" title="Return to list" variant="plain"
                onPress={() => navigate('identity', '')} />
        </ReviewFrame>;
    }
    if (subPath !== '' && subPath !== 'identity') {
        return <ErrorState title="Review location is unavailable"
            action={<Button title="Return to list" onPress={() => navigate('', '')} />} />;
    }
    return <Collection testID="review.project.collection" model={model} anatomy={PROJECT_REVIEW_ANATOMY}
        title="Project review" accessibilityLabel="Project review" presentation="list" detail="auto"
        minListWidth={320} minDetailWidth={480} preferredListRatio={0.4}
        detailHeader={() => ({ title: 'Accepted Project identity', actions: <DetailsPaneOpenAsPageButton
            testID="review.project.openAsPage" onPress={() => navigate('identity/page', 'identity')} /> })}
        renderDetail={() => detail} />;
}

function readDestinationLocalId(context: RenderContext): string | null {
    const mount = context.surface.mount;
    return mount.kind === 'destination' ? mount.destination.localId : null;
}

/**
 * The embedded Session-widget mount, or `null`.
 *
 * A widget is NOT a destination: it has no destination identity, so a renderer
 * shared with destinations must read the embedded role instead of falling
 * through to its default view.
 */
function readSessionWidgetMount(
    context: RenderContext,
): Readonly<{ presentation: 'content' | 'fill' }> | null {
    const mount = context.surface.mount;
    return mount.kind === 'embedded' && mount.role === 'widget'
        ? { presentation: mount.presentation }
        : null;
}

/**
 * The one bounded input this widget accepts. The host stores it with the Board
 * item and passes it back verbatim at every mount; anything else is ignored
 * rather than guessed at.
 */
function readReviewWidgetView(launchInput: unknown): 'summary' | 'detail' {
    if (launchInput && typeof launchInput === 'object' && !Array.isArray(launchInput)) {
        const view = (launchInput as Readonly<Record<string, unknown>>).view;
        if (view === 'detail') return 'detail';
    }
    return 'summary';
}

type OpenableContentPanelState = Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; result: ReviewOpenableContentResult }>
    | Readonly<{ kind: 'error' }>;

function ReviewFrame({
    children,
    accessibilityLabel = 'Review assistant',
}: Readonly<{
    children: React.ReactNode;
    accessibilityLabel?: string;
}>) {
    return (
        <Screen>
            <ScrollArea accessibilityLabel={accessibilityLabel}>
                <Stack gap="medium">
                    {children}
                </Stack>
            </ScrollArea>
        </Screen>
    );
}

export function ReviewOverview({ pinnedArea }: Readonly<{ pinnedArea: boolean }>) {
    const [draft, setDraft] = React.useState('Example review transcript');
    return (
        <ReviewFrame>
            {/* The page's declared `pinned` area: the host draws the widgets, gallery and layout. */}
            {pinnedArea ? <WidgetSurface area="pinned" /> : null}
            <SetupBlockGrid testID="review.dictation.intro" columns={1} items={[{
                id: 'review-dictation',
                renderTile: ({ open }) => <SetupBlockTile testID="review.dictation.tile" layout="row"
                    glyph={<VoiceMarkArt pose="mic" size={32} still />}
                    title="Dictate a review"
                    subtitle="Add spoken notes to your transcript, then review them before summarizing."
                    action={{ label: 'How it works', testID: 'review.dictation.how', onPress: open }} />,
                renderPanel: ({ close }) => <Stack gap="medium">
                    <SetupSteps testID="review.dictation.steps" steps={[
                        { key: 'speak', title: 'Tap Dictate in the transcript field',
                            detail: 'Allow microphone access when asked. Your selected Dictation engine hears the notes.' },
                        { key: 'review', title: 'Review the words',
                            detail: 'Dictation adds editable text. It never sends the transcript.',
                            body: <><StatusCell kind="needs_you" label="Review the transcript before summarizing" still />
                                <Text value="You decide what stays in the review." tone="secondary" /></> },
                        { key: 'summarize', title: 'Summarize when you are ready',
                            detail: 'The review action runs only when you press Summarize review.' },
                    ]} />
                    <Button title="Back to the review" variant="plain" onPress={close} />
                </Stack>,
            }]} fallback={<Text value="Dictation adds editable notes to the transcript. Review them before summarizing." tone="secondary" />} />
            <Card padding="large">
                <Stack gap="small">
                    <Status tone="success" label="Review assistant ready" />
                    <Text value="Review assistant" variant="heading" />
                    <Text
                        value="Run the declared review action through the current host API."
                        tone="secondary"
                    />
                    <TextField label="Review transcript" value={draft} onChange={setDraft} multiline
                        dictation={{
                            onTranscription: (words) => setDraft((current) => current ? `${current}\n${words}` : words),
                            fallback: <Text value="Type your transcript when Dictation is unavailable." tone="secondary" />,
                        }} />
                    <Action.Execute
                        action="review-summary"
                        input={{ transcript: draft }}
                        title="Summarize review"
                    />
                </Stack>
            </Card>
        </ReviewFrame>
    );
}

function ReviewSessionStatusPanel({
    context,
    activity = false,
}: Readonly<{
    context: RenderContext;
    activity?: boolean;
}>) {
    const { resource, refresh } = useLivePluginResource('review-session-status');
    const title = activity ? 'Project Companion activity' : 'Review status';
    React.useEffect(() => {
        if (!activity) return;
        context.hostApi.publishCurrentUiContext(PROJECT_COMPANION_ACTIVITY_CURRENT_UI_CONTEXT);
        return () => context.hostApi.publishCurrentUiContext(null);
    }, [activity, context.hostApi]);
    const refreshAction = <Action.Refresh title="Refresh status" onRefresh={refresh} />;
    const detailsAction = activity
        ? <Action.OpenSurface view={REVIEW_SESSION_STATUS_VIEW_ID} title="Open review details" variant="primary" />
        : undefined;
    const recoveryActions = activity ? (
        <Stack gap="small">
            {detailsAction}
            {refreshAction}
        </Stack>
    ) : refreshAction;

    if (resource.value === undefined) {
        if (resource.error) {
            return (
                <ReviewFrame accessibilityLabel={title}>
                    <ErrorState
                        title="Review status is unavailable"
                        description="The current Session status could not be loaded."
                        action={recoveryActions}
                    />
                </ReviewFrame>
            );
        }
        if (resource.pending !== 'idle') {
            return (
                <ReviewFrame accessibilityLabel={title}>
                    <LoadingState title="Loading review status" />
                </ReviewFrame>
            );
        }
        return (
            <ReviewFrame accessibilityLabel={title}>
                <EmptyState
                    scene={NO_REVIEW_STATUS_SCENE}
                    title="No review status"
                    description="This Session does not have a declared review status yet."
                    action={recoveryActions}
                />
            </ReviewFrame>
        );
    }

    if (resource.value.contentType !== 'text/plain') {
        return (
            <ReviewFrame accessibilityLabel={title}>
                <ErrorState
                    title="Review status is unavailable"
                    description="The host returned an unsupported status format."
                    action={recoveryActions}
                />
            </ReviewFrame>
        );
    }

    const summary = new TextDecoder().decode(resource.value.bytes).trim();
    if (summary.length === 0) {
        return (
            <ReviewFrame accessibilityLabel={title}>
                <EmptyState
                    scene={NO_REVIEW_STATUS_SCENE}
                    title="No review status"
                    description="This Session does not have a declared review status yet."
                    action={recoveryActions}
                />
            </ReviewFrame>
        );
    }

    const refreshing = resource.pending === 'refresh';
    const stale = resource.freshness === 'stale' || resource.error !== undefined;
    return (
        <ReviewFrame accessibilityLabel={title}>
            <Card padding="large">
                <Stack gap="small">
                    <Status
                        tone={stale ? 'warning' : 'success'}
                        label={refreshing
                            ? 'Refreshing review status'
                            : stale
                                ? 'Showing last known review status'
                                : 'Current review status'}
                        pulsing={refreshing}
                    />
                    <Text value={title} variant="heading" />
                    <Text value={summary} selectable />
                    {detailsAction}
                    {refreshAction}
                </Stack>
            </Card>
        </ReviewFrame>
    );
}

function describeOpenableContentResult(result: Exclude<ReviewOpenableContentResult, Readonly<{
    status: 'ready';
}>>): Readonly<{ title: string; description: string }> {
    switch (result.status) {
        case 'tooLarge':
            return {
                title: 'Review file is too large',
                description: 'The selected file exceeds this viewer’s bounded 64 KB read limit.',
            };
        case 'changed':
            return {
                title: 'Review file changed',
                description: 'The file changed before a consistent snapshot could be read. Reload it to try again.',
            };
        case 'unsupported':
            return {
                title: 'Review file is unavailable',
                description: 'The current host cannot provide this selected file to the review viewer.',
            };
        case 'cancelled':
            return {
                title: 'Review file read was cancelled',
                description: 'Reload the selected file if the review is still needed.',
            };
        case 'unavailable':
            return {
                title: 'Review file is unavailable',
                description: 'The selected file is no longer available to this review viewer.',
            };
    }
}

function ReviewOpenableContentPanel({
    context,
    handle,
}: Readonly<{
    context: RenderContext;
    handle: string;
}>) {
    const [reloadToken, setReloadToken] = React.useState(0);
    const [state, setState] = React.useState<OpenableContentPanelState>({ kind: 'loading' });
    const reload = React.useCallback(() => setReloadToken((current) => current + 1), []);

    React.useEffect(() => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) controller.abort();
        setState({ kind: 'loading' });

        void readReviewOpenableContent(
            context.hostApi,
            { kind: 'workspaceFile', handle },
            controller.signal,
        ).then((result) => {
            if (!controller.signal.aborted) setState({ kind: 'ready', result });
        }).catch(() => {
            if (!controller.signal.aborted) setState({ kind: 'error' });
        });

        return () => {
            context.signal.removeEventListener('abort', abort);
            controller.abort();
        };
    }, [context.hostApi, context.signal, handle, reloadToken]);

    const reloadAction = <Action.Refresh title="Reload file" onRefresh={reload} />;
    if (state.kind === 'loading') {
        return (
            <ReviewFrame>
                <LoadingState title="Loading selected review file" />
            </ReviewFrame>
        );
    }
    if (state.kind === 'error') {
        return (
            <ReviewFrame>
                <ErrorState
                    title="Review file is unavailable"
                    description="The selected file could not be read through the host viewer API."
                    action={reloadAction}
                />
            </ReviewFrame>
        );
    }
    if (state.result.status !== 'ready') {
        const copy = describeOpenableContentResult(state.result);
        return (
            <ReviewFrame>
                <ErrorState {...copy} action={reloadAction} />
            </ReviewFrame>
        );
    }
    if (state.result.content.kind !== 'utf8') {
        return (
            <ReviewFrame>
                <ErrorState
                    title="Review file is unavailable"
                    description="The selected content is not text that this review viewer can present."
                    action={reloadAction}
                />
            </ReviewFrame>
        );
    }

    return (
        <ReviewFrame>
            <Card padding="large">
                <Stack gap="small">
                    <Status tone="success" label="Bounded review snapshot" />
                    <Text value="Selected review file" variant="heading" />
                    <Text
                        value={`${state.result.mimeType} · ${state.result.sizeBytes} bytes`}
                        tone="secondary"
                        variant="micro"
                    />
                    <CodeBlock
                        code={state.result.content.text}
                        language={state.result.mimeType === 'text/markdown' ? 'markdown' : 'text'}
                    />
                    {reloadAction}
                </Stack>
            </Card>
        </ReviewFrame>
    );
}

/**
 * React Native renderer for both declared review destinations. The semantic
 * entry installs the package-local provider, so this surface consumes the
 * mounted host API without a second bridge, resource store, or lifecycle.
 */
/**
 * The embedded Session widget.
 *
 * It is the same declared surface a Board, Details, sidebar, Companion or mobile
 * host frames — this renderer adapts to the space it is given rather than to a
 * Happier shell name. `content` is a framed card whose host owns bounds and
 * scrolling; `fill` owns its own content scroll.
 */
function ReviewStatusWidget({
    context,
    presentation,
}: Readonly<{
    context: RenderContext;
    presentation: 'content' | 'fill';
}>) {
    const view = readReviewWidgetView(context.launchInput);
    const { resource, refresh } = useLivePluginResource('review-session-status');

    if (context.surface.target.kind !== 'session') {
        return (
            <ErrorState
                title="Review status needs a Session"
                description="This widget reads the review status of the Session it is placed in."
            />
        );
    }

    const refreshAction = <Action.Refresh title="Refresh status" onRefresh={refresh} />;
    if (resource.value === undefined) {
        if (resource.error) {
            return (
                <ErrorState
                    title="Review status is unavailable"
                    description="The current Session status could not be loaded."
                    action={refreshAction}
                />
            );
        }
        return resource.pending !== 'idle'
            ? <LoadingState title="Loading review status" />
            : (
                <EmptyState
                    title="No review status"
                    description="This Session does not have a declared review status yet."
                    action={refreshAction}
                />
            );
    }

    const summary = resource.value.contentType === 'text/plain'
        ? new TextDecoder().decode(resource.value.bytes).trim()
        : '';
    if (summary.length === 0) {
        return (
            <EmptyState
                title="No review status"
                description="This Session does not have a declared review status yet."
                action={refreshAction}
            />
        );
    }

    const refreshing = resource.pending === 'refresh';
    const stale = resource.freshness === 'stale' || resource.error !== undefined;
    // A compact host gets one current fact and one action; the expanded host may
    // show the full status body.
    const body = (
        <Card padding={presentation === 'fill' ? 'large' : 'medium'}>
            <Stack gap="small">
                <Status
                    tone={stale ? 'warning' : 'success'}
                    label={refreshing
                        ? 'Refreshing review status'
                        : stale
                            ? 'Showing last known review status'
                            : 'Current review status'}
                    pulsing={refreshing}
                />
                <Text value="Review status" variant="heading" />
                <Text
                    value={summary}
                    selectable
                    {...(view === 'summary' ? { numberOfLines: 3 } : {})}
                />
                <Action.Execute
                    action="review-summary"
                    input={{ transcript: summary }}
                    title="Summarize review"
                />
                {refreshAction}
            </Stack>
        </Card>
    );

    // Only the expanded mount owns its own scroll; a `content` widget stays
    // inside the host's scroll owner.
    return presentation === 'fill'
        ? <ReviewFrame accessibilityLabel="Review status">{body}</ReviewFrame>
        : body;
}

function ReviewPanel(context: RenderContext) {
    if (context.surface.mount.kind === 'embedded' && context.surface.mount.role === 'ephemeralInput') {
        const input = readInputTypePickerLaunchInput(context.launchInput);
        return (
            <ReviewFrame accessibilityLabel="Choose repository">
                <Text value="Choose repository" variant="heading" />
                {!input ? <ErrorState title="Repository choices are unavailable" /> : null}
                {input?.options?.filter(option => !option.disabled).map((option) => (
                    <Button key={actionInputOptionValueKey(option.value)} title={option.label}
                        onPress={() => context.hostApi.settleEphemeralInput({ kind: 'completed', input: option.value }, { signal: context.signal })} />
                ))}
                <Button title="Cancel" variant="plain"
                    onPress={() => context.hostApi.settleEphemeralInput({ kind: 'cancelled' }, { signal: context.signal })} />
            </ReviewFrame>
        );
    }
    const widget = readSessionWidgetMount(context);
    if (widget) {
        return <ReviewStatusWidget context={context} presentation={widget.presentation} />;
    }

    const destinationLocalId = readDestinationLocalId(context);
    if (destinationLocalId === SESSION_SKILL_REFERENCE_VIEW_ID) {
        return <ReviewFrame accessibilityLabel="Skill reference"><SessionSkillReference context={context} /></ReviewFrame>;
    }
    if (destinationLocalId === REVIEW_PROJECT_PAGE_VIEW_ID) {
        return <ReviewProjectPage context={context} />;
    }
    if (destinationLocalId === REVIEW_SESSION_STATUS_VIEW_ID) {
        return context.surface.target.kind === 'session'
            ? <ReviewSessionStatusPanel context={context} />
            : (
                <ReviewFrame>
                    <ErrorState
                        title="Review status is unavailable"
                        description="The review status view requires a Session target."
                    />
                </ReviewFrame>
            );
    }

    if (destinationLocalId === PROJECT_COMPANION_ACTIVITY_VIEW_ID) {
        return context.surface.target.kind === 'session'
            ? <ReviewSessionStatusPanel context={context} activity />
            : (
                <ReviewFrame accessibilityLabel="Project Companion activity">
                    <ErrorState
                        title="Project Companion activity is unavailable"
                        description="Open this activity from a Session so it can read that Session’s review status."
                    />
                </ReviewFrame>
            );
    }

    if (destinationLocalId === PROJECT_COMPANION_PROJECT_ACTIVITY_VIEW_ID) {
        return (
            <ReviewFrame accessibilityLabel="Project Companion activity">
                <ErrorState
                    title="Project Companion activity needs a Session"
                    description="Open the Session activity from its header to review the current Session status."
                />
            </ReviewFrame>
        );
    }

    if (destinationLocalId === REVIEW_OPENABLE_CONTENT_VIEW_ID) {
        const reference = readReviewOpenableContentReference(context.launchInput);
        return reference === undefined
            ? (
                <ReviewFrame accessibilityLabel="Selected review file">
                    <ErrorState
                        title="Review file is unavailable"
                        description="Open this viewer from a host-selected review file."
                    />
                </ReviewFrame>
            )
            : <ReviewOpenableContentPanel context={context} handle={reference.handle} />;
    }

    return <ReviewOverview pinnedArea={destinationLocalId === REVIEW_PANEL_VIEW_ID} />;
}

/** One of this plugin's review snippets: what the picker lists and previews. */
export type ReviewSnippet = Readonly<{ id: string; title: string; shortcut: string; editedLabel: string }>;

/**
 * A small controlled picker over this plugin's own review snippets, drawn with Happier's public prompt-picker
 * row and preview. The plugin owns its data, its reads and what choosing a snippet does; the picker pieces own
 * only the composition, and a failed read is the shared `SurfaceState` line. It registers nothing.
 */
export function ReviewSnippetPicker(props: Readonly<{
    snippets: readonly ReviewSnippet[];
    /** Reads one snippet's full text; the preview says when it fails. */
    read: (snippet: ReviewSnippet) => Promise<string>;
}>) {
    const theme = usePluginTheme();
    const [query, setQuery] = React.useState('');
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const colors: HappierPromptPickerColors = {
        text: theme.colors.text,
        secondaryText: theme.colors.secondaryText,
        tertiaryText: theme.colors.mutedText,
        divider: theme.colors.divider,
    };
    const marks = {
        all: { backgroundColor: theme.colors.control },
        current: { backgroundColor: theme.colors.accent, color: theme.colors.onAccent },
    };
    const visible = props.snippets.filter((snippet) => !query || snippet.title.toLowerCase().includes(query.toLowerCase()));
    const selected = visible.find((snippet) => snippet.id === selectedId) ?? visible[0] ?? null;
    const meta = (snippet: ReviewSnippet): readonly HappierPromptPickerMetaPart[] => [
        { text: 'Snippet' },
        { text: `/${snippet.shortcut}`, token: true },
    ];
    return (
        <Stack gap="small">
            {/* The `/` belongs to the field: what is typed continues it, and the field keeps its own name. */}
            <TextField label="Filter snippets" presentation="field" value={query} onChange={setQuery}
                placeholder="Filter" leading={<HappierText>/</HappierText>} />
            <Row gap="none">
                <Stack gap="none" grow>
                    {visible.map((snippet) => {
                        const match = matchFindText(snippet.title, query, { matchCase: false, regex: false });
                        return (
                            <HappierPressable key={snippet.id} onPress={() => setSelectedId(snippet.id)}
                                accessibilityRole="button" accessibilityLabel={snippet.title} selected={snippet.id === selected?.id}>
                                <HappierPromptPickerRow host={SNIPPET_PICKER_HOST} colors={colors} meta={meta(snippet)}
                                    glyph={<Icon name="forward" size="small" tone="muted" />}
                                    title={<HappierFindHighlightedText text={snippet.title}
                                        ranges={'ranges' in match ? match.ranges.map(([start, end]) => ({ start, end, current: false })) : []}
                                        marks={marks} />}
                                    testID={`review-snippet:${snippet.id}`} />
                            </HappierPressable>
                        );
                    })}
                </Stack>
                {selected
                    ? <ReviewSnippetPreview key={selected.id} snippet={selected} meta={meta(selected)} read={props.read} colors={colors} />
                    : null}
            </Row>
        </Stack>
    );
}

function ReviewSnippetPreview(props: Readonly<{
    snippet: ReviewSnippet;
    meta: readonly HappierPromptPickerMetaPart[];
    read: (snippet: ReviewSnippet) => Promise<string>;
    colors: HappierPromptPickerColors;
}>) {
    const [state, setState] = React.useState<Readonly<{ text?: string; failed?: true }> | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const { read, snippet } = props;
    React.useEffect(() => {
        let current = true;
        setState(null);
        read(snippet).then(
            (text) => { if (current) setState({ text }); },
            () => { if (current) setState({ failed: true }); },
        );
        return () => { current = false; };
    }, [read, snippet, attempt]);
    return (
        <HappierPromptPickerPreview host={SNIPPET_PICKER_HOST} colors={props.colors} meta={props.meta}
            action="Inserts" origin={snippet.editedLabel}>
            {state?.failed
                // The shared line on the preview's own edge, announced once, with its one recovery.
                ? <SurfaceState size="line" kind="error" accessibilitySemantics="alert" title="Couldn’t read this snippet"
                    action={{ label: 'Retry', onPress: () => setAttempt((value) => value + 1) }} />
                : state?.text !== undefined
                    ? <HappierText variant="body">{state.text}</HappierText>
                    : <SurfaceState size="line" kind="loading" title="Reading the snippet" />}
        </HappierPromptPickerPreview>
    );
}

/** The picker's text binding: Happier's text in the role, colour and figures the picker asks for. */
const SNIPPET_PICKER_HOST: HappierPromptPickerHost = {
    Text: ({ children, variant, color, numberOfLines, mono, tabularNumbers, testID }) => (
        <HappierText variant={mono ? 'code' : variant} numberOfLines={numberOfLines}
            tabularNumbers={tabularNumbers} testID={testID} style={{ color }}>
            {children}
        </HappierText>
    ),
};

export const renderSurface = defineUiSurface(ReviewPanel);
