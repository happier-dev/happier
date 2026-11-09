import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    isScmCommitPlanApplicationLocked,
    type ScmDiffSummaryResult,
    type ScmDiffSummaryResultEdit, type ScmDiffSummaryWalkthrough,
} from '@happier-dev/protocol/scm';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { ScmComparisonMenuSection } from '@/components/sessions/files/comparison/ScmComparisonMoreMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { WalkthroughStopNumber } from './WalkthroughAtoms';
import { Typography } from '@/constants/Typography';
import type { createScmDiffSummaryResultOperations, ScmCommitPlanOperationResult } from '@/sync/ops/scmDiffSummary/results';
import { t } from '@/text';
import { useWalkthroughDraft } from './useWalkthroughDraft';

export type WalkthroughSavedActionsProps = Readonly<{
    result: ScmDiffSummaryResult;
    cwd: string;
    operations: ReturnType<typeof createScmDiffSummaryResultOperations>;
    onResult: (result: ScmDiffSummaryResult) => void;
    onError?: (failure: Extract<ScmCommitPlanOperationResult, { success: false }>) => void;
    disabledReason?: string | null;
    canGenerate?: boolean;
    onUndo?: () => void;
    undoing?: boolean;
    /** A native host has no Session composer; the same saved-result owner admits its discussion. */
    nativeDiscussion?: boolean;
    nativeDiscussionReply?: string | null;
    /** The update notice already offers Undo beside "Saved result updated"; the menu doesn't repeat it. */
    undoInNotice?: boolean;
    /** The pushed phone reading: the open edit takes the narrower inset. */
    phone?: boolean;
    /** Exact Account/host/result identity, excluding its changing revision. */
    editorKey?: string;
    paneScopeId?: string;
}>;

export type WalkthroughSavedActions = Readonly<{
    /** The saved result's operations as rows of the comparison menu (the wide bar's `⋯`, the phone menu). */
    section: ScmComparisonMenuSection | null;
    /** What an operation opens (the editor, a discussion, a failure), in the reading column under the header. */
    panel: React.ReactNode;
}>;

/**
 * The saved result's operations. They are offered once, in the comparison menu, so the reading column holds the
 * reading; choosing one opens its editor in place under the header. Drafts follow the retained pane lifetime;
 * all saved state and revision decisions stay at the machine owner.
 */
export function useWalkthroughSavedActions(input: WalkthroughSavedActionsProps | null): WalkthroughSavedActions {
    const { theme } = useUnistyles();
    // Without a saved result nothing below runs an operation or renders: the handlers and the panel are reached
    // only while `present`, so they read `props` as the saved input it then is.
    const props = input as WalkthroughSavedActionsProps;
    const present = input !== null;
    const [draft, setDraft] = useWalkthroughDraft(input
        ? input.editorKey ?? JSON.stringify([input.cwd, input.result.resultId]) : null, input?.paneScopeId);
    const [refining, setRefining] = React.useState(false);
    const [discussing, setDiscussing] = React.useState(false);
    const [message, setMessage] = React.useState('');
    const [instructions, setInstructions] = React.useState('');
    const [failure, setFailure] = React.useState<Extract<ScmCommitPlanOperationResult, { success: false }> | null>(null);
    const [busy, setBusy] = React.useState(false);
    const pending = React.useRef(false);
    const lifetime = React.useRef(0);
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
        setRefining(false);
        setDiscussing(false);
        setMessage('');
        setInstructions('');
        setFailure(null);
        setBusy(false);
        pending.current = false;
        return () => { lifetime.current += 1; };
    }, [input?.cwd, input?.result.resultId, input?.operations]);

    const walkthrough = input?.result.output.outputs?.walkthrough?.value;
    const disabledReason = input?.disabledReason || (input && isScmCommitPlanApplicationLocked(input.result.application)
        ? t('walkthrough.saved.applicationLocked') : null);
    const blocked = Boolean(disabledReason) || busy || input?.undoing === true;
    const canGenerate = Boolean(input?.result.generator) && input?.canGenerate !== false;
    const revisionInput = (expectedRevision = props.result.revision) => ({ cwd: props.cwd, resultId: props.result.resultId, expectedRevision });

    async function invoke(operation: () => Promise<ScmCommitPlanOperationResult>, options?: Readonly<{ rebaseDraft?: boolean }>) {
        if (pending.current || disabledReason) return;
        pending.current = true;
        setBusy(true);
        const captured = { lifetime: lifetime.current, resultId: props.result.resultId, operations: props.operations };
        try {
            const response = await operation();
            if (captured.lifetime !== lifetime.current || latest.current.result.resultId !== captured.resultId
                || latest.current.operations !== captured.operations) return;
            if (!response.success) {
                setFailure(response);
                latest.current.onError?.(response);
                return;
            }
            // The transport validates the response. A later observation must not be replaced by an older response.
            if (response.result.revision < latest.current.result.revision) return;
            setFailure(null);
            setDraft((current) => current ? {
                ...current, expectedRevision: response.result.revision,
                base: response.result.output.outputs?.walkthrough?.value ?? current.base,
            } : null);
            if (!options?.rebaseDraft) { setRefining(false); setDiscussing(false); setMessage(''); }
            latest.current.onResult(response.result);
        } finally {
            if (captured.lifetime === lifetime.current) {
                pending.current = false;
                setBusy(false);
            }
        }
    }

    function edit(command: ScmDiffSummaryResultEdit) {
        const input = revisionInput(draft?.expectedRevision);
        return invoke(() => props.operations.edit({ ...input, edit: command }));
    }

    function openEdit() {
        if (blocked || !walkthrough) return;
        setDraft({ expectedRevision: props.result.revision, base: walkthrough, title: walkthrough.title, stopTitle: '', prose: '' });
        setFailure(null);
    }

    function selectStop(stopId: string) {
        if (blocked || !walkthrough) return;
        const base = draft?.base ?? walkthrough;
        const stop = base.stops.find((entry) => entry.id === stopId);
        if (!stop) return;
        setDraft((current) => ({ expectedRevision: current?.expectedRevision ?? props.result.revision, base,
            title: current?.title ?? base.title, stopId, stopTitle: stop.title, prose: stop.explanationMarkdown }));
        setFailure(null);
    }

    function moveStop(direction: -1 | 1) {
        if (!draft?.stopId) return;
        const stopIds = draft.base.stops.map((stop) => stop.id);
        const from = stopIds.indexOf(draft.stopId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= stopIds.length) return;
        [stopIds[from], stopIds[to]] = [stopIds[to]!, stopIds[from]!];
        return edit({ kind: 'reorderStops', stopIds });
    }

    const selectedIndex = draft?.stopId ? draft.base.stops.findIndex((stop) => stop.id === draft.stopId) : -1;
    const selectedExists = selectedIndex >= 0;
    const nextStop = selectedExists ? draft?.base.stops[selectedIndex + 1] : undefined;
    const iconColor = theme.colors.text.secondary;
    const icon = (name: React.ComponentProps<typeof Icon>['name']) => <Icon name={name} size={ICON_SIZE.sm} color={iconColor} />;
    const items: DropdownMenuItem[] = [];
    const subtitle = disabledReason ?? undefined;
    if (present && walkthrough) items.push({ id: 'edit', testID: 'walkthrough-saved-edit', title: t('walkthrough.saved.edit'), icon: icon('pencil-simple'), disabled: blocked, subtitle });
    if (present && props.result.canUndo && !props.undoInNotice) items.push({ id: 'undo', testID: 'walkthrough-saved-undo', title: t('walkthrough.saved.undoLast'), icon: icon('arrow-arc-left'), disabled: blocked, subtitle });
    if (present && canGenerate) items.push({ id: 'refine', testID: 'walkthrough-saved-refine', title: t('walkthrough.saved.refine'), icon: icon('sparkle'), disabled: blocked || !walkthrough, subtitle });
    if (present && canGenerate && props.nativeDiscussion) items.push({ id: 'discuss', testID: 'walkthrough-saved-discuss', title: t('walkthrough.saved.discuss'), icon: icon('chat-circle-dots'), disabled: blocked, subtitle });
    if (present && canGenerate && !props.result.output.outputs?.summary) items.push({ id: 'add-summary', testID: 'walkthrough-saved-add-summary', title: t('walkthrough.saved.addSummary'), icon: icon('file-text'), disabled: blocked, subtitle });
    // Propose commits is the comparison's (its Commits view adds the proposal to this walkthrough), never a second row here.
    const select = (id: string) => {
        if (blocked) return;
        if (id === 'edit') openEdit();
        else if (id === 'undo') void (props.onUndo ?? (() => invoke(() => props.operations.undo(revisionInput()))))();
        else if (id === 'refine' && walkthrough) { if (!draft) openEdit(); setRefining(true); }
        else if (id === 'discuss') setDiscussing(true);
        else if (id === 'add-summary') void invoke(() => props.operations.addOutputs({ ...revisionInput(), outputs: ['summary'] }));
    };
    const selectRef = React.useRef(select);
    selectRef.current = select;
    const itemsKey = JSON.stringify(items.map((item) => [item.id, item.disabled === true, item.subtitle ?? '', item.title]));
    const section = React.useMemo<ScmComparisonMenuSection | null>(() => (items.length === 0 ? null
        : { id: 'walkthrough-saved', items, onSelect: (id) => selectRef.current(id) }),
    // The rows are rebuilt each render; the section keeps its identity while they read the same.
    [itemsKey, iconColor]);
    // The open stop's fields, under its row; a stop removed elsewhere keeps its draft after the outline.
    const stopEditor = (stop: ScmDiffSummaryWalkthrough['stops'][number] | undefined) => !draft ? null : (
        <View style={styles.stopEditor}>
            <SavedField id="stop-title" label={t('walkthrough.saved.stopTitle')} value={draft.stopTitle} editable={!blocked} selectTextOnFocus
                onChange={(stopTitle) => setDraft((current) => current ? { ...current, stopTitle } : null)}
                trailing={<SavedAction id="stop-title-save" label={t('common.save')} inField
                    disabled={blocked || !selectedExists || !draft.stopTitle.trim() || draft.stopTitle === stop?.title}
                    onPress={() => edit({ kind: 'renameStop', stopId: draft.stopId!, title: draft.stopTitle })} />} />
            <SavedField id="prose" label={t('walkthrough.saved.prose')} value={draft.prose} multiline editable={!blocked}
                onChange={(prose) => setDraft((current) => current ? { ...current, prose } : null)} />
            <View style={styles.stopActions}>
                <SavedAction id="move-up" label={t('walkthrough.saved.moveUp')} disabled={blocked || selectedIndex <= 0} onPress={() => moveStop(-1)} />
                <SavedAction id="move-down" label={t('walkthrough.saved.moveDown')} disabled={blocked || !nextStop} onPress={() => moveStop(1)} />
                <SavedAction id="merge-next" label={t('walkthrough.saved.mergeNext')} disabled={blocked || !nextStop || !draft.prose.trim() || !draft.stopTitle.trim()}
                    onPress={() => nextStop ? edit({ kind: 'mergeStops', stopIds: [draft.stopId!, nextStop.id], targetStopId: draft.stopId!,
                        title: draft.stopTitle, explanationMarkdown: `${draft.prose}\n\n${nextStop.explanationMarkdown}` }) : undefined} />
                <View style={styles.grow} />
                <SavedAction id="prose-save" label={t('common.save')} primary
                    disabled={blocked || !selectedExists || !draft.prose.trim() || draft.prose === stop?.explanationMarkdown}
                    onPress={() => edit({ kind: 'editStop', stopId: draft.stopId!, explanationMarkdown: draft.prose })} />
            </View>
        </View>
    );
    const open = Boolean(draft || discussing || failure || (input?.nativeDiscussion && input.nativeDiscussionReply));
    const panel = !present || !open ? null : (
        <View testID="walkthrough-saved-actions" style={styles.root}>
            {discussing ? <View style={styles.editor}>
                <SavedField id="message" label={t('walkthrough.saved.message')} value={message} multiline editable={!blocked} onChange={setMessage} />
                <SavedAction id="discuss-send" label={t('common.send')} disabled={blocked || !message.trim()}
                    onPress={() => invoke(() => props.operations.discuss({ ...revisionInput(), message }))} />
                <SavedAction id="discuss-cancel" label={t('common.cancel')} disabled={busy}
                    onPress={() => { setDiscussing(false); setMessage(''); }} />
            </View> : null}
            {props.nativeDiscussion && props.nativeDiscussionReply ? <Text testID="walkthrough-saved-discussion-reply" style={styles.reason}>
                {props.nativeDiscussionReply}
            </Text> : null}
            {disabledReason && (draft || discussing) ? <Text style={styles.reason}>{disabledReason}</Text> : null}
            {failure ? <View testID="walkthrough-saved-error" accessibilityRole="alert" style={styles.feedback}>
                <Text style={styles.error}>{failure.errorCode === 'revision_conflict' ? t('walkthrough.saved.conflict') : failure.error}</Text>
                {failure.errorCode === 'revision_conflict' ? <SavedAction id="reload" label={t('walkthrough.saved.reload')} disabled={blocked}
                    onPress={() => invoke(() => props.operations.read({ cwd: props.cwd, resultId: props.result.resultId }), { rebaseDraft: true })} /> : null}
            </View> : null}
            {draft ? <View testID="walkthrough-saved-editor" style={[styles.sheet, input?.phone ? styles.sheetPhone : null]}>
                <View style={styles.sheetHeader}>
                    <Text accessibilityRole="header" style={styles.sheetTitle}>{t('walkthrough.saved.edit')}</Text>
                    <SavedAction id="cancel" label={t('walkthrough.done')} disabled={busy}
                        onPress={() => { setDraft(null); setRefining(false); setFailure(null); }} />
                </View>
                <SavedField id="title" label={t('walkthrough.saved.title')} value={draft.title} editable={!blocked} selectTextOnFocus
                    onChange={(title) => setDraft((current) => current ? { ...current, title } : null)}
                    trailing={<SavedAction id="title-save" label={t('common.save')} inField
                        disabled={blocked || !draft.title.trim() || draft.title === draft.base.title}
                        onPress={() => edit({ kind: 'renameWalkthrough', title: draft.title })} />} />
                <View style={styles.field}>
                    <Text style={styles.label}>{t('walkthrough.contents')}</Text>
                    <View style={styles.stopList}>
                        {draft.base.stops.map((stop, index) => {
                            const on = draft.stopId === stop.id;
                            return <React.Fragment key={stop.id}>
                                <HappierPressable testID={`walkthrough-saved-stop-${stop.id}`} accessibilityRole="button" accessibilityLabel={stop.title}
                                    selected={on} disabled={blocked} onPress={() => selectStop(stop.id)}
                                    style={(state) => [styles.stopRow, index > 0 ? styles.stopRowDivider : null, on ? styles.stopRowOn : null,
                                        state.pressed ? styles.stopRowPressed : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                                    <WalkthroughStopNumber number={index + 1} reviewed={false} size="rail" />
                                    <Text style={[styles.stopRowTitle, on ? styles.stopRowTitleOn : null]} numberOfLines={1}>{stop.title}</Text>
                                    <Icon name={on ? 'caret-up' : 'caret-down'} size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
                                </HappierPressable>
                                {on ? stopEditor(stop) : null}
                            </React.Fragment>;
                        })}
                    </View>
                    {draft.stopId && !selectedExists ? <>
                        <Text style={styles.reason}>{t('walkthrough.saved.missingStop')}</Text>
                        {stopEditor(undefined)}
                    </> : null}
                </View>
                {refining && canGenerate ? <View style={styles.field}>
                    <SavedField id="instructions" label={t('walkthrough.saved.instructions')} value={instructions} multiline editable={!blocked}
                        onChange={setInstructions} />
                    <View style={styles.stopActions}>
                        <View style={styles.grow} />
                        <SavedAction id="refine-send" label={t('walkthrough.saved.refine')} primary
                            disabled={blocked || Boolean(draft.stopId && !selectedExists) || !instructions.trim()}
                            onPress={() => invoke(() => props.operations.refine({ ...revisionInput(draft.expectedRevision), output: 'walkthrough',
                                instructions, ...(draft.stopId ? { stopIds: [draft.stopId] } : {}) }))} />
                    </View>
                </View> : null}
            </View> : null}
        </View>
    );
    return { section, panel };
}

/** `primary` commits the open edit; `inField` is a field's own Save; the rest are quiet text actions. */
function SavedAction(props: Readonly<{ id: string; label: string; disabled?: boolean; primary?: boolean; inField?: boolean; onPress: () => void | Promise<void> }>) {
    return <RoundButton testID={`walkthrough-saved-${props.id}`} title={props.label} accessibilityLabel={props.label}
        size={props.inField ? 'mini' : 'small'} display={props.primary ? 'secondary' : 'inverted'} titleNumberOfLines="complete" disabled={props.disabled}
        onPress={() => { if (!props.disabled) return props.onPress(); }} />;
}

function SavedField(props: Readonly<{ id: string; label: string; value: string; editable: boolean; multiline?: boolean;
    selectTextOnFocus?: boolean; trailing?: React.ReactNode; onChange: (value: string) => void }>) {
    const labelId = React.useId();
    return <View style={styles.field}>
        <Text nativeID={labelId} style={styles.label}>{props.label}</Text>
        <FieldTextInput testID={`walkthrough-saved-${props.id}`} accessibilityLabel={props.label} accessibilityLabelledBy={labelId}
            value={props.value} onChangeText={props.onChange} multiline={props.multiline} editable={props.editable}
            selectTextOnFocus={props.selectTextOnFocus} trailing={props.trailing} presentation={props.multiline ? 'document' : 'field'} />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    root: { gap: PAGE_LIST_METRICS.sectionHeaderGapPx, paddingBottom: theme.space.s16 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: PAGE_LIST_METRICS.groupHeadingGapPx, alignItems: 'center' },
    editor: { gap: PAGE_LIST_METRICS.sectionHeaderGapPx, paddingVertical: PAGE_LIST_METRICS.rowPaddingVerticalPx },
    // The open edit is one quiet sheet in the reading column (flat edge), holding the walkthrough's own outline.
    sheet: {
        marginTop: theme.space.s16,
        gap: theme.space.s20,
        padding: theme.space.s20,
        borderRadius: theme.borderRadius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    // On the pushed phone reading the sheet runs edge to edge, as the hunk cards do, so its rows keep the page gutter.
    sheetPhone: { marginHorizontal: -theme.space.s16, padding: theme.space.s16, marginTop: 0, borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minHeight: 32 },
    sheetTitle: { flex: 1, ...Typography.variant('heading'), color: theme.colors.text.primary },
    grow: { flex: 1 },
    field: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
    label: { ...Typography.variant('label'), color: theme.colors.text.secondary },
    stopList: {
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
    },
    stopRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, minHeight: 40, paddingHorizontal: theme.space.s12 },
    stopRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    stopRowOn: { backgroundColor: theme.colors.surface.selected },
    stopRowPressed: { backgroundColor: theme.colors.surface.pressed },
    stopRowTitle: { flex: 1, ...Typography.variant('body'), color: theme.colors.text.secondary },
    stopRowTitleOn: { color: theme.colors.text.primary, ...Typography.variant('body', 'medium') },
    stopEditor: { gap: theme.space.s16, padding: theme.space.s16, backgroundColor: theme.colors.surface.selected },
    stopActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s4 },
    reason: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    error: { ...Typography.variant('body'), color: theme.colors.state.danger.foreground },
    feedback: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
}));
