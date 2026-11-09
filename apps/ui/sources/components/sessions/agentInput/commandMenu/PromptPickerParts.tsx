import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { resolveOverlayMotionPreset, useOverlayMotionAnimation } from '@/components/ui/overlays/motion/overlayMotion';
import { SelectionListFooter } from '@/components/ui/selectionList/SelectionListFooter';
import { FavoriteToggleButton } from '@/components/ui/buttons/FavoriteToggleButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SELECTION_LIST_SKELETON_ROW_SHAPE } from '@/components/ui/selectionList/_constants';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Typography } from '@/constants/Typography';
import {
    HAPPIER_PROMPT_PICKER_METRICS,
    HappierPromptPickerPreview,
    HappierPromptPickerRow,
    type HappierPromptPickerColors,
    type HappierPromptPickerHost,
    type HappierPromptPickerMetaPart,
} from '@happier-dev/plugin-ui/presentation';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { isEscapeKeyEvent } from '@/keyboard/escape';
import { formatKeybindingLabel } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { t } from '@/text';
import type { PromptPickerRow } from './promptPickerRows';
import { useSaveMessageAsPrompt, type SaveMessageAsPromptSaved } from '@/components/sessions/transcript/messageActions/useSaveMessageAsPrompt';

type RowLabels = Readonly<{
    nowMs: number;
    folderNames: ReadonlyMap<string, string>;
    sessionNames: ReadonlyMap<string, string>;
}>;

const ARGUMENTS_TOKEN = '$ARGUMENTS';

type MetaPart = HappierPromptPickerMetaPart;

/** "Library · /e2e · Testing", "Built in · /review" or "Fix settings modal remount · 12m ago"; `/tokens` are marked. */
function describeRow(row: PromptPickerRow, labels: RowLabels): readonly MetaPart[] {
    if (row.kind === 'history') {
        const session = labels.sessionNames.get(row.entry.sessionId);
        // A session is usually named after its first message; that text is already the title.
        const named = session && !sharesLeadingText(session, row.title) ? [{ text: session }] : [];
        return [...named, { text: formatRelativeTimeShort(row.entry.createdAtMs, labels.nowMs), fixed: true as const }];
    }
    const tokens = row.tokens.map((text): MetaPart => ({ text, token: true }));
    if (row.kind === 'builtIn') return [{ text: t('agentInput.promptPicker.builtIn') }, ...tokens];
    const place = row.document.folderId ? labels.folderNames.get(row.document.folderId) : row.document.tags[0];
    return [{ text: t('agentInput.promptPicker.library') }, ...tokens, ...(place ? [{ text: place }] : [])];
}

const squash = (text: string) => text.replace(/\s+/g, ' ').replace(/(?:…|\.{3})$/, '').trim().toLowerCase();

/** True when one text is the start of the other, e.g. a session named from its first message. */
function sharesLeadingText(a: string, b: string): boolean {
    const [x, y] = [squash(a), squash(b)];
    return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
}

/** Core's text for the picker presentation: its type roles, faces and font scaling. */
function PromptPickerText(props: React.ComponentProps<HappierPromptPickerHost['Text']>) {
    return <Text variant={props.variant} emphasis={props.emphasis} numberOfLines={props.numberOfLines} testID={props.testID}
        style={[props.color ? { color: props.color } : null, props.mono ? Typography.mono() : null, props.tabularNumbers ? Typography.tabular() : null]}>
        {props.children}
    </Text>;
}

const PROMPT_PICKER_HOST: HappierPromptPickerHost = { Text: PromptPickerText };

function usePromptPickerColors(): HappierPromptPickerColors {
    const { theme } = useUnistyles();
    const { text, border } = theme.colors;
    return React.useMemo(() => ({ text: text.primary, secondaryText: text.secondary, tertiaryText: text.tertiary, divider: border.default }),
        [text.primary, text.secondary, text.tertiary, border.default]);
}

export function PromptPickerRowContent(props: RowLabels & Readonly<{
    row: PromptPickerRow;
    query: string;
    onToggleFavorite: () => void;
}>) {
    const { theme } = useUnistyles();
    const { row } = props;
    const colors = usePromptPickerColors();
    const title = row.kind === 'history' ? row.title.replace(/\s+/g, ' ').trim() : row.title;
    return <HappierPromptPickerRow testID={`prompt-picker-row:${row.id}`} host={PROMPT_PICKER_HOST} colors={colors}
        glyph={<Icon name={row.kind === 'history' ? 'clock-counter-clockwise' : 'chat'} size={HAPPIER_PROMPT_PICKER_METRICS.glyphPx} color={theme.colors.text.secondary} />}
        title={<FindHighlightedText text={title} ranges={queryRanges(title, props.query)} />}
        meta={describeRow(row, props)}
        accessory={row.kind === 'doc' ? <FavoriteToggleButton id={row.document.artifactId} isFavorite={row.document.favorite}
            addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
            onToggle={props.onToggleFavorite} testID={`prompt-picker-favorite:${row.id}`} />
            // Starring something you sent turns it into a favourite prompt where it stands (lab R1s).
            : row.kind === 'history' ? <FavoriteToggleButton id={row.id} isFavorite={false}
                addLabel={t('agentInput.promptPicker.saveAsFavorite')} removeLabel={t('agentInput.promptPicker.saveAsFavorite')}
                onToggle={props.onToggleFavorite} testID={`prompt-picker-favorite:${row.id}`} /> : null} />;
}

/** The full text of the highlighted row, with what ↵ will do and where it came from. */
export function PromptPickerPreview(props: RowLabels & Readonly<{ row: PromptPickerRow; read: (row: PromptPickerRow) => Promise<string> }>) {
    const contentRevision = props.row.kind === 'doc' ? props.row.document.updatedAtMs
        : props.row.kind === 'builtIn' ? props.row.prompt.body : props.row.entry.text;
    const contentId = props.row.id;
    const latestRow = React.useRef(props.row);
    latestRow.current = props.row;
    const [preview, setPreview] = React.useState<Readonly<{ id: string; revision: typeof contentRevision; attempt: number; text?: string; error?: true }> | null>(null);
    // Retry asks the same reader again for the same row; the skeleton holds the place while it does.
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        let active = true;
        void props.read(latestRow.current).then((text) => { if (active) setPreview({ id: contentId, revision: contentRevision, attempt, text }); },
            () => { if (active) setPreview({ id: contentId, revision: contentRevision, attempt, error: true }); });
        return () => { active = false; };
    }, [attempt, contentId, contentRevision, props.read]);
    const current = preview?.id === contentId && preview.revision === contentRevision && preview.attempt === attempt ? preview : null;
    const colors = usePromptPickerColors();
    const { row } = props;
    const kind = row.kind === 'history' ? t('agentInput.promptPicker.previewSent') : t('agentInput.promptPicker.previewInserts');
    // Only a library prompt has a footer (lab R1 "Edited 3 days ago"); a sent message's session already leads the header meta.
    const origin = row.kind === 'doc' ? t('agentInput.promptPicker.previewEdited', { time: formatRelativeTimeShort(row.document.updatedAtMs, props.nowMs) }) : null;
    return <HappierPromptPickerPreview testID="prompt-picker-preview" host={PROMPT_PICKER_HOST} colors={colors}
        meta={describeRow(row, props)} action={kind} origin={origin}>
        {current?.error ? <SurfaceStateCard testID="prompt-picker-preview-failed" size="line" kind="error" accessibilitySemantics="alert"
            title={t('agentInput.promptPicker.readError')}
            action={{ label: t('common.retry'), onPress: () => setAttempt((value) => value + 1), testID: 'prompt-picker-preview-retry' }} />
            : current?.text !== undefined ? <PreviewText text={current.text} markdown={row.kind !== 'history'} />
            : <SkeletonRows rows={1} {...SELECTION_LIST_SKELETON_ROW_SHAPE} />}
    </HappierPromptPickerPreview>;
}

/**
 * The prompt as the reader should see it: a leading YAML front matter block (a skill's `name`,
 * `description`, `metadata`) is machine header, not prompt text, so the preview starts at the body.
 */
export function promptPreviewDisplayText(text: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return readableMessageText(match ? text.slice(match[0].length).replace(/^\s+/, '') : text);
}

/**
 * `$ARGUMENTS` is where the caret lands after insert, so the preview marks it as code. A saved prompt
 * is markdown: it renders through the same renderer as every other document; what you sent stays the
 * plain text it was.
 */
function markArguments(markdown: string): string {
    return markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part.split(ARGUMENTS_TOKEN).join(`\`${ARGUMENTS_TOKEN}\``)).join('');
}

function PreviewText(props: Readonly<{ text: string; markdown: boolean }>) {
    const text = promptPreviewDisplayText(props.text);
    if (props.markdown) return <MarkdownView profile="widget" markdown={markArguments(text)} />;
    return <Text selectable style={styles.previewText}>{text}</Text>;
}

export function PromptPickerSkeletonRow(props: Readonly<{ testID?: string }>) {
    return <View style={styles.skeleton} testID={props.testID}>
        <SkeletonRows rows={3} {...SELECTION_LIST_SKELETON_ROW_SHAPE} />
    </View>;
}

/** The move from Sent before into Favourites: the row rises into its new group (lab R1s, 200 ms; reduced motion fades). */
const SAVE_ROW_MOTION = resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' });

/**
 * A Sent before row becoming a favourite prompt in place (lab R1s): its first line as a focused name
 * field, Save, and the star that decides whether it lands in Favourites. It saves through the one
 * "message becomes a prompt" owner the message row uses; Escape or Cancel puts it back.
 */
export function PromptPickerSaveRow(props: Readonly<{
    row: Extract<PromptPickerRow, { kind: 'history' }>;
    serverId: string;
    nowMs: number;
    onSaved: (saved: SaveMessageAsPromptSaved) => void;
    onCancel: () => void;
}>) {
    const { theme } = useUnistyles();
    const form = useSaveMessageAsPrompt({ text: props.row.entry.text, serverId: props.serverId, onSaved: props.onSaved });
    const motion = useOverlayMotionAnimation({ visible: true, preset: SAVE_ROW_MOTION });
    const time = formatRelativeTimeShort(props.row.entry.createdAtMs, props.nowMs);
    const submit = form.canSave ? () => { void form.save(); } : undefined;
    return <Animated.View style={[styles.row, styles.saveRow, motion.style]} testID={`prompt-picker-save:${props.row.id}`}>
        <View style={[styles.lead, styles.saveLead]}>
            <Icon name="chat" size={METRICS.glyphPx} color={theme.colors.text.secondary} />
        </View>
        <View style={styles.body}>
            <View style={styles.saveLine}>
                <FieldTextInput testID="prompt-picker-save-name" accessibilityLabel={t('committedMessageActions.name')}
                    value={form.title} onChangeText={form.setTitle} autoFocus selectTextOnFocus returnKeyType="done"
                    onSubmitEditing={submit} style={styles.saveField}
                    onKeyPress={(event) => {
                        if (!isEscapeKeyEvent(event)) return;
                        event.preventDefault?.();
                        (event as unknown as { stopPropagation?: () => void }).stopPropagation?.();
                        props.onCancel();
                    }} />
                <RoundButton testID="prompt-picker-save-confirm" size="small" title={t('common.save')}
                    disabled={!form.canSave} loading={form.isSaving} action={form.save} />
            </View>
            <View style={[styles.actionLine, styles.saveMeta]}>
                <Text style={[styles.meta, form.error ? styles.noticeError : null]} accessibilityLiveRegion="polite">
                    {form.error ?? t(form.favorite ? 'agentInput.promptPicker.saveInPlaceStarred' : 'agentInput.promptPicker.saveInPlace', { time })}
                </Text>
                <View style={styles.action}><Text style={styles.meta}>{' · '}</Text>
                    <TextLinkButton label={t('common.cancel')} onPress={props.onCancel} testID="prompt-picker-save-cancel" />
                </View>
            </View>
        </View>
        <View style={styles.saveStar}>
            <FavoriteToggleButton id={props.row.id} isFavorite={form.favorite} testID="prompt-picker-save-favorite"
                addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
                onToggle={() => form.setFavorite((value) => !value)} />
        </View>
    </Animated.View>;
}

/**
 * Hints for the keys the field owns (hardware keyboards only), then one short status for the history
 * search: older pages are searched on demand, with progress and Stop, and what was searched stays said.
 * The status is one line at every state, so the footer keeps its height and never wraps the hints.
 */
export function PromptPickerFooter(props: Readonly<{
    history: UserMessageHistoryEntriesSnapshot;
    hardwareKeyboard: boolean;
    /** The two-pane picker; the phone-width one is a touch-first list and leaves key hints out. */
    wide?: boolean;
    canSend: boolean;
    applyError: boolean;
    /** The library is still arriving while other rows (built-ins, history) already show. */
    libraryLoading?: boolean;
}>) {
    const { history } = props;
    const platform = resolveKeyboardPlatform();
    const pickerShortcut = useKeyboardShortcutLabel('composer.prompts.open');
    const { sessionsSearched: searched, totalSessions: total } = history.progress;
    // One state at a time, in order: a failed apply, the search running (Stop), the search failed
    // (Retry), the library arriving, then the settled coverage with its next step.
    const end = props.applyError ? <StatusLine tone="error" text={t('agentInput.promptPicker.applyError')} />
        : history.isLoading ? <StatusLine text={t('agentInput.promptPicker.searchingOlder', { searched, total })}
            action={<TextLinkButton label={t('agentInput.promptPicker.stop')} onPress={history.stop} testID="prompt-picker-history-stop" />} />
        : history.error ? <StatusLine tone="error" text={t('agentInput.promptPicker.historyError')}
            action={<TextLinkButton label={t('common.retry')} onPress={() => history.retry()} tone="strong" testID="prompt-picker-history-retry" />} />
        : props.libraryLoading ? <StatusLine text={t('agentInput.promptPicker.loadingLibrary')} />
        // Each "Search more" reads further back; the settled line keeps the count, so every press shows its progress.
        : history.coverage === 'partial' && history.hasMore && searched > 0 ? <StatusLine
            text={t('agentInput.promptPicker.searchedOlder', { searched, total })}
            action={<TextLinkButton label={t('agentInput.promptPicker.searchMore')} onPress={() => { void history.loadMore(); }} testID="prompt-picker-history-more" />} />
        : history.coverage !== 'complete' ? <StatusLine
            text={t(history.coverage === 'partial' ? 'agentInput.promptPicker.partialHistory' : 'agentInput.promptPicker.loadedHistory')}
            action={history.hasMore ? <TextLinkButton label={t('agentInput.promptPicker.loadOlder')}
                onPress={() => { void history.loadMore(); }} testID="prompt-picker-history-more" /> : undefined} />
        : null;
    const hints = props.hardwareKeyboard && props.wide !== false;
    if (!hints && !end) return null;
    return <SelectionListFooter testID="prompt-picker-footer" hardwareKeyboardAvailable={hints} action={end} hints={[
        { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
        { id: 'insert', label: '↵', description: t('agentInput.promptPicker.insert') },
        ...(props.canSend ? [{ id: 'send', label: formatKeybindingLabel({ binding: 'Mod+Enter' }, platform), description: t('agentInput.promptPicker.send') }] : []),
        { id: 'favorite', label: formatKeybindingLabel({ binding: 'Mod+D' }, platform), description: t('agentInput.promptPicker.favorite') },
        ...(!end && pickerShortcut ? [{ id: 'open', label: pickerShortcut, description: t('agentInput.promptPicker.title') }] : []),
    ]} />;
}

/** The footer's one status: a sentence that ellipsizes rather than wraps, then its next step after a quiet separator. */
function StatusLine(props: Readonly<{ text: string; tone?: 'error'; action?: React.ReactNode }>) {
    return <View style={styles.footerEnd} testID="prompt-picker-history-status">
        <Text style={[styles.status, props.tone === 'error' ? styles.noticeError : null]} numberOfLines={1}
            accessibilityLiveRegion="polite">{props.text}</Text>
        {props.action ? <View style={styles.action}><Text style={styles.status}>{'· '}</Text>{props.action}</View> : null}
    </View>;
}

const METRICS = HAPPIER_PROMPT_PICKER_METRICS;

const styles = StyleSheet.create((theme) => ({
    // The in-place save row stands on the presentation's row anatomy, so it rises into the list in line.
    row: { flexDirection: 'row', alignItems: 'center', gap: METRICS.rowGapPx, paddingLeft: METRICS.rowPaddingLeftPx,
        paddingRight: METRICS.rowPaddingRightPx, paddingVertical: METRICS.rowPaddingVerticalPx, minHeight: METRICS.rowMinHeightPx },
    lead: { width: METRICS.leadColumnPx, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 1 },
    meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    // The field and Save share one line; the meta says where it goes.
    saveRow: { alignItems: 'flex-start', paddingVertical: theme.space.s10 },
    saveLead: { marginTop: theme.space.s8 },
    saveLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    saveField: { flex: 1, minWidth: 0 },
    saveMeta: { marginTop: theme.space.s6 },
    saveStar: { marginTop: theme.space.s6 },
    previewText: { ...Typography.default(), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.text.primary },
    noticeError: { color: theme.colors.state.danger.foreground },
    actionLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
    action: { flexDirection: 'row', alignItems: 'center' },
    skeleton: { paddingHorizontal: theme.space.s4 },
    footerEnd: { flexShrink: 1, minWidth: 0, flexDirection: 'row', gap: theme.space.s6, justifyContent: 'flex-end', alignItems: 'center', marginLeft: 'auto' },
    status: { ...({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }), color: theme.colors.text.secondary, textAlign: 'right', flexShrink: 1, minWidth: 0 },
}));
