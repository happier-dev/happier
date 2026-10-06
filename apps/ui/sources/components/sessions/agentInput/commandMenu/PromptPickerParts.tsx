import * as React from 'react';
import { Animated, ScrollView, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { matchFindText, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { resolveOverlayMotionPreset, useOverlayMotionAnimation } from '@/components/ui/overlays/motion/overlayMotion';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { PathFavoriteToggleButton } from '@/components/ui/pathPicker/PathFavoriteToggleButton';
import { SelectionListSkeletonRow } from '@/components/ui/selectionList/SelectionListSkeletonRow';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
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

type MetaPart = Readonly<{ text: string; token?: true }>;

/** "Library · /e2e · Testing", "Built in · /review" or "Fix settings modal remount · 12m ago"; `/tokens` are marked. */
function describeRow(row: PromptPickerRow, labels: RowLabels): readonly MetaPart[] {
    if (row.kind === 'history') {
        const session = labels.sessionNames.get(row.entry.sessionId);
        return [session, formatRelativeTimeShort(row.entry.createdAtMs, labels.nowMs)].filter((text): text is string => Boolean(text)).map((text) => ({ text }));
    }
    const tokens = row.tokens.map((text): MetaPart => ({ text, token: true }));
    if (row.kind === 'builtIn') return [{ text: t('agentInput.promptPicker.builtIn') }, ...tokens];
    const place = row.document.folderId ? labels.folderNames.get(row.document.folderId) : row.document.tags[0];
    return [{ text: t('agentInput.promptPicker.library') }, ...tokens, ...(place ? [{ text: place }] : [])];
}

function MetaLine(props: Readonly<{ parts: readonly MetaPart[]; style: StyleProp<TextStyle>; trailing?: string }>) {
    return <Text style={props.style} numberOfLines={1}>{props.parts.map((part, index) => <React.Fragment key={index}>
        {index ? ' · ' : ''}{part.token ? <Text style={styles.token}>{part.text}</Text> : part.text}
    </React.Fragment>)}{props.trailing ? ` · ${props.trailing}` : ''}</Text>;
}

function queryRanges(text: string, query: string): readonly FindTextRange[] | undefined {
    const needle = query.trim();
    if (!needle) return undefined;
    const result = matchFindText(text, needle, { matchCase: false, regex: false });
    return 'ranges' in result ? result.ranges.map(([start, end]) => ({ start, end, current: false })) : undefined;
}

export function PromptPickerRowContent(props: RowLabels & Readonly<{
    row: PromptPickerRow;
    query: string;
    onHighlight: () => void;
    onToggleFavorite: () => void;
}>) {
    const { theme } = useUnistyles();
    const { row } = props;
    const title = row.kind === 'history' ? row.title.replace(/\s+/g, ' ').trim() : row.title;
    return <View style={styles.row} testID={`prompt-picker-row:${row.id}`} {...{ onMouseEnter: props.onHighlight }}>
        <View style={styles.lead}>
            <Icon name={row.kind === 'history' ? 'clock-counter-clockwise' : 'chat'} size={16} color={theme.colors.text.secondary} />
        </View>
        <View style={styles.body}>
            <Text style={styles.title} numberOfLines={1}><FindHighlightedText text={title} ranges={queryRanges(title, props.query)} /></Text>
            <MetaLine style={styles.meta} parts={describeRow(row, props)} />
        </View>
        {row.kind === 'doc' ? <PathFavoriteToggleButton path={row.document.artifactId} isFavorite={row.document.favorite}
            addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
            onToggle={props.onToggleFavorite} testID={`prompt-picker-favorite:${row.id}`} />
            // Starring something you sent turns it into a favourite prompt where it stands (lab R1s).
            : row.kind === 'history' ? <PathFavoriteToggleButton path={row.id} isFavorite={false}
                addLabel={t('agentInput.promptPicker.saveAsFavorite')} removeLabel={t('agentInput.promptPicker.saveAsFavorite')}
                onToggle={props.onToggleFavorite} testID={`prompt-picker-favorite:${row.id}`} /> : null}
    </View>;
}

/** The full text of the highlighted row, with what ↵ will do and where it came from. */
export function PromptPickerPreview(props: RowLabels & Readonly<{ row: PromptPickerRow; read: (row: PromptPickerRow) => Promise<string> }>) {
    const contentRevision = props.row.kind === 'doc' ? props.row.document.updatedAtMs
        : props.row.kind === 'builtIn' ? props.row.prompt.body : props.row.entry.text;
    const contentId = props.row.id;
    const latestRow = React.useRef(props.row);
    latestRow.current = props.row;
    const [preview, setPreview] = React.useState<Readonly<{ id: string; revision: typeof contentRevision; text?: string; error?: true }> | null>(null);
    React.useEffect(() => {
        let active = true;
        void props.read(latestRow.current).then((text) => { if (active) setPreview({ id: contentId, revision: contentRevision, text }); },
            () => { if (active) setPreview({ id: contentId, revision: contentRevision, error: true }); });
        return () => { active = false; };
    }, [contentId, contentRevision, props.read]);
    const current = preview?.id === contentId && preview.revision === contentRevision ? preview : null;
    const { row } = props;
    const kind = row.kind === 'history' ? t('agentInput.promptPicker.previewSent') : t('agentInput.promptPicker.previewInserts');
    const origin = row.kind === 'doc' ? t('agentInput.promptPicker.previewEdited', { time: formatRelativeTimeShort(row.document.updatedAtMs, props.nowMs) })
        : row.kind === 'history' ? props.sessionNames.get(row.entry.sessionId) || null : null;
    return <View style={styles.preview} testID="prompt-picker-preview">
        <MetaLine style={styles.previewMeta} parts={describeRow(row, props)} trailing={kind} />
        <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewScrollContent}>
            {current?.error ? <Text style={styles.previewError}>{t('agentInput.promptPicker.readError')}</Text>
                : current?.text !== undefined ? <PreviewText text={current.text} />
                : <SelectionListSkeletonRow index={0} />}
        </ScrollView>
        {origin ? <Text style={styles.previewMeta} numberOfLines={1}>{origin}</Text> : null}
    </View>;
}

/** `$ARGUMENTS` is where the caret lands after insert, so the preview marks it. */
function PreviewText(props: Readonly<{ text: string }>) {
    const parts = props.text.split(ARGUMENTS_TOKEN);
    return <Text selectable style={styles.previewText}>{parts.map((part, index) => <React.Fragment key={index}>
        {part}
        {index < parts.length - 1 ? <Text style={styles.argument}>{ARGUMENTS_TOKEN}</Text> : null}
    </React.Fragment>)}</Text>;
}

/** One quiet line in the list: an invitation, an empty result or a recoverable failure. */
export function PromptPickerNotice(props: Readonly<{
    text: string;
    title?: string;
    tone?: 'default' | 'error';
    action?: Readonly<{ label: string; onPress: () => void }>;
    testID?: string;
}>) {
    return <View style={styles.notice} testID={props.testID}>
        {props.title ? <Text style={styles.noticeTitle}>{props.title}</Text> : null}
        <Text style={[styles.noticeText, props.tone === 'error' ? styles.noticeError : null]} accessibilityLiveRegion="polite">
            {props.text}
            {props.action ? <>
                {' · '}
                <Text style={styles.link} accessibilityRole="button" onPress={props.action.onPress}
                    testID={props.testID ? `${props.testID}:action` : undefined}>{props.action.label}</Text>
            </> : null}
        </Text>
    </View>;
}

export function PromptPickerSkeletonRow(props: Readonly<{ testID?: string }>) {
    return <View style={styles.skeleton} testID={props.testID}><SelectionListSkeletonRow index={1} /></View>;
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
            <Icon name="chat" size={16} color={theme.colors.text.secondary} />
        </View>
        <View style={styles.body}>
            <View style={styles.saveLine}>
                <FieldTextInput testID="prompt-picker-save-name" accessibilityLabel={t('committedMessageActions.name')}
                    value={form.title} onChangeText={form.setTitle} autoFocus selectTextOnFocus returnKeyType="done"
                    onSubmitEditing={submit} style={styles.saveField}
                    onKeyPress={(event) => {
                        if (event.nativeEvent.key !== 'Escape') return;
                        event.preventDefault?.();
                        (event as unknown as { stopPropagation?: () => void }).stopPropagation?.();
                        props.onCancel();
                    }} />
                <RoundButton testID="prompt-picker-save-confirm" size="small" title={t('common.save')}
                    disabled={!form.canSave} loading={form.isSaving} action={form.save} />
            </View>
            <Text style={[styles.meta, styles.saveMeta, form.error ? styles.noticeError : null]} accessibilityLiveRegion="polite">
                {form.error ?? t(form.favorite ? 'agentInput.promptPicker.saveInPlaceStarred' : 'agentInput.promptPicker.saveInPlace', { time })}
                {' · '}<Text style={styles.link} accessibilityRole="button" onPress={props.onCancel} testID="prompt-picker-save-cancel">{t('common.cancel')}</Text>
            </Text>
        </View>
        <View style={styles.saveStar}>
            <PathFavoriteToggleButton path={props.row.id} isFavorite={form.favorite} testID="prompt-picker-save-favorite"
                addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
                onToggle={() => form.setFavorite((value) => !value)} />
        </View>
    </Animated.View>;
}

/**
 * Hints for the keys the field owns (hardware keyboards only), then the honest state of the
 * history search: older pages are searched on demand, with progress and Stop.
 */
export function PromptPickerFooter(props: Readonly<{
    history: UserMessageHistoryEntriesSnapshot;
    hardwareKeyboard: boolean;
    canSend: boolean;
    applyError: boolean;
}>) {
    const { history } = props;
    const platform = resolveKeyboardPlatform();
    const pickerShortcut = useKeyboardShortcutLabel('composer.prompts.open');
    const status = props.applyError ? <Text style={[styles.status, styles.noticeError]} accessibilityLiveRegion="polite">{t('agentInput.promptPicker.applyError')}</Text>
        : history.error ? <Text style={[styles.status, styles.noticeError]} accessibilityLiveRegion="polite">
            {t('agentInput.promptPicker.historyError')}{' · '}<FooterLink label={t('common.retry')} onPress={history.retry} />
        </Text>
        : history.isLoading ? <Text style={styles.status} accessibilityLiveRegion="polite">
            {t('agentInput.promptPicker.searchingOlder', { searched: history.progress.sessionsSearched, total: history.progress.totalSessions })}
            {' · '}<FooterLink label={t('agentInput.promptPicker.stop')} onPress={history.stop} testID="prompt-picker-history-stop" />
        </Text>
        : history.hasMore ? <Text style={styles.status}>
            <FooterLink label={t('agentInput.promptPicker.loadOlder')} onPress={() => { void history.loadMore(); }} testID="prompt-picker-history-more" />
        </Text>
        : null;
    const coverage = history.coverage === 'partial' ? t('agentInput.promptPicker.partialHistory')
        : history.coverage === 'loaded' ? t('agentInput.promptPicker.loadedHistory') : null;
    if (!props.hardwareKeyboard && !status && !coverage) return null;
    return <View style={styles.footer} testID="prompt-picker-footer">
        {props.hardwareKeyboard ? <View style={styles.hints}>
            <Hint keys="↑↓" label={t('commandPalette.hints.move')} />
            <Hint keys="↵" label={t('agentInput.promptPicker.insert')} />
            {props.canSend ? <Hint keys={formatKeybindingLabel({ binding: 'Mod+Enter' }, platform)} label={t('agentInput.promptPicker.send')} /> : null}
            <Hint keys={formatKeybindingLabel({ binding: 'Mod+D' }, platform)} label={t('agentInput.promptPicker.favorite')} />
        </View> : null}
        <View style={styles.footerEnd}>
            {coverage ? <Text style={styles.status} accessibilityLiveRegion="polite" testID="prompt-picker-history-coverage">{coverage}</Text> : null}
            {status ?? (!coverage && props.hardwareKeyboard && pickerShortcut ? <Hint keys={pickerShortcut} label={t('agentInput.promptPicker.title')} /> : null)}
        </View>
    </View>;
}

function Hint(props: Readonly<{ keys: string; label: string }>) {
    return <View style={styles.hint}><KeyHint label={props.keys} /><Text style={styles.hintLabel}>{props.label}</Text></View>;
}

function FooterLink(props: Readonly<{ label: string; onPress: () => void; testID?: string }>) {
    return <Text style={styles.link} accessibilityRole="button" onPress={props.onPress} testID={props.testID}>{props.label}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 10, paddingVertical: 7, minHeight: 48 },
    lead: { width: 20, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 1 },
    title: { ...Typography.default(), fontSize: 14, lineHeight: 19, color: theme.colors.text.primary },
    meta: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
    token: Typography.mono(),
    // The in-place save row: the field and Save share one line; the meta says where it goes.
    saveRow: { alignItems: 'flex-start', paddingVertical: 10 },
    saveLead: { marginTop: 9 },
    saveLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    saveField: { flex: 1, minWidth: 0 },
    saveMeta: { marginTop: 6 },
    saveStar: { marginTop: 6 },
    preview: { width: 300, flexShrink: 0, minHeight: 0, gap: 8, paddingHorizontal: 14, paddingVertical: 12,
        borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
    previewMeta: { ...Typography.timestamp(), color: theme.colors.text.tertiary },
    previewScroll: { flex: 1, minHeight: 0 },
    previewScrollContent: { paddingBottom: 4 },
    previewText: { ...Typography.default(), fontSize: 13, lineHeight: 19, color: theme.colors.text.primary },
    previewError: { ...Typography.default(), fontSize: 13, lineHeight: 19, color: theme.colors.state.danger.foreground },
    argument: { ...Typography.mono('semiBold'), fontSize: 12, color: theme.colors.text.link, backgroundColor: theme.colors.state.info.background },
    notice: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 6 },
    noticeTitle: { ...Typography.default('semiBold'), fontSize: 12, lineHeight: 16, color: theme.colors.text.secondary },
    noticeText: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.text.secondary },
    noticeError: { color: theme.colors.state.danger.foreground },
    link: { color: theme.colors.text.link },
    skeleton: { paddingHorizontal: 4 },
    footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4, minHeight: 34,
        paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    hints: { maxWidth: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4 },
    footerEnd: { maxWidth: '100%', flexGrow: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', alignItems: 'center' },
    hint: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    hintLabel: { ...Typography.timestamp(), color: theme.colors.text.tertiary },
    status: { ...Typography.timestamp(), color: theme.colors.text.secondary, textAlign: 'right' },
}));
