import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    isScmCommitPlanApplicationLocked,
    type ScmDiffSummaryResult, type ScmDiffSummaryResultFailure, type ScmDiffSummaryResultResponse,
    type ScmDiffSummaryResultEdit, type ScmDiffSummaryWalkthrough,
} from '@happier-dev/protocol/scm';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
import { t } from '@/text';

export type WalkthroughSavedActionsProps = Readonly<{
    result: ScmDiffSummaryResult;
    cwd: string;
    operations: ReturnType<typeof createScmDiffSummaryResultOperations>;
    onResult: (result: ScmDiffSummaryResult) => void;
    onError?: (failure: ScmDiffSummaryResultFailure) => void;
    disabledReason?: string | null;
    canGenerate?: boolean;
    onUndo?: () => void;
    undoing?: boolean;
}>;

type Draft = Readonly<{
    expectedRevision: number;
    base: ScmDiffSummaryWalkthrough;
    title: string;
    stopId?: string;
    stopTitle: string;
    prose: string;
}>;

/** Drafts belong to this editing leaf; all saved state and revision decisions stay at the machine owner. */
export function WalkthroughSavedActions(props: WalkthroughSavedActionsProps) {
    const [draft, setDraft] = React.useState<Draft | null>(null);
    const [refining, setRefining] = React.useState(false);
    const [instructions, setInstructions] = React.useState('');
    const [failure, setFailure] = React.useState<ScmDiffSummaryResultFailure | null>(null);
    const [busy, setBusy] = React.useState(false);
    const pending = React.useRef(false);
    const lifetime = React.useRef(0);
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
        setDraft(null);
        setRefining(false);
        setInstructions('');
        setFailure(null);
        setBusy(false);
        pending.current = false;
        return () => { lifetime.current += 1; };
    }, [props.cwd, props.result.resultId, props.operations]);

    const walkthrough = props.result.output.outputs?.walkthrough?.value;
    const disabledReason = props.disabledReason || (isScmCommitPlanApplicationLocked(props.result.application)
        ? t('walkthrough.saved.applicationLocked') : null);
    const blocked = Boolean(disabledReason) || busy || props.undoing === true;
    const canGenerate = Boolean(props.result.generator) && props.canGenerate !== false;
    const revisionInput = (expectedRevision = props.result.revision) => ({ cwd: props.cwd, resultId: props.result.resultId, expectedRevision });

    async function invoke(operation: () => Promise<ScmDiffSummaryResultResponse>, options?: Readonly<{ rebaseDraft?: boolean }>) {
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
            if (!options?.rebaseDraft) setRefining(false);
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
    return (
        <View testID="walkthrough-saved-actions" style={styles.root}>
            <View style={styles.actions}>
                {walkthrough ? <SavedAction id="edit" label={t('walkthrough.saved.edit')} disabled={blocked} onPress={openEdit} /> : null}
                {props.result.canUndo ? <SavedAction id="undo" label={t('walkthrough.notice.undo')} disabled={blocked}
                    onPress={props.onUndo ?? (() => invoke(() => props.operations.undo(revisionInput())))} /> : null}
                {canGenerate ? <SavedAction id="refine" label={t('walkthrough.saved.refine')} disabled={blocked || !walkthrough}
                    onPress={() => { if (!blocked) { if (!draft) openEdit(); setRefining(true); } }} /> : null}
                {canGenerate && !props.result.output.outputs?.summary ? <SavedAction id="add-summary" label={t('walkthrough.saved.addSummary')} disabled={blocked}
                    onPress={() => invoke(() => props.operations.addOutputs({ ...revisionInput(), outputs: ['summary'] }))} /> : null}
                {canGenerate && props.result.output.comparison?.source.kind === 'workingTree' && !props.result.output.outputs?.commitPlan
                    ? <SavedAction id="add-commitPlan" label={t('walkthrough.saved.addCommitPlan')} disabled={blocked}
                        onPress={() => invoke(() => props.operations.addOutputs({ ...revisionInput(), outputs: ['commitPlan'] }))} /> : null}
            </View>
            {disabledReason ? <Text style={styles.reason}>{disabledReason}</Text> : null}
            {failure ? <View testID="walkthrough-saved-error" accessibilityRole="alert" style={styles.feedback}>
                <Text style={styles.error}>{failure.errorCode === 'revision_conflict' ? t('walkthrough.saved.conflict') : failure.error}</Text>
                {failure.errorCode === 'revision_conflict' ? <SavedAction id="reload" label={t('walkthrough.saved.reload')} disabled={blocked}
                    onPress={() => invoke(() => props.operations.read({ cwd: props.cwd, resultId: props.result.resultId }), { rebaseDraft: true })} /> : null}
            </View> : null}
            {draft ? <View style={styles.editor}>
                <SavedField id="title" label={t('walkthrough.saved.title')} value={draft.title} editable={!blocked}
                    onChange={(title) => setDraft((current) => current ? { ...current, title } : null)} />
                <SavedAction id="title-save" label={t('common.save')} disabled={blocked || !draft.title.trim()}
                    onPress={() => edit({ kind: 'renameWalkthrough', title: draft.title })} />
                <View style={styles.actions}>
                    {draft.base.stops.map((stop) => <SavedAction key={stop.id} id={`stop-${stop.id}`} label={stop.title} disabled={blocked}
                        selected={draft.stopId === stop.id} onPress={() => selectStop(stop.id)} />)}
                </View>
                {draft.stopId ? <>
                    {!selectedExists ? <Text style={styles.reason}>{t('walkthrough.saved.missingStop')}</Text> : null}
                    <SavedField id="stop-title" label={t('walkthrough.saved.stopTitle')} value={draft.stopTitle} editable={!blocked}
                        onChange={(stopTitle) => setDraft((current) => current ? { ...current, stopTitle } : null)} />
                    <SavedAction id="stop-title-save" label={t('common.save')} disabled={blocked || !selectedExists || !draft.stopTitle.trim()}
                        onPress={() => edit({ kind: 'renameStop', stopId: draft.stopId!, title: draft.stopTitle })} />
                    <SavedField id="prose" label={t('walkthrough.saved.prose')} value={draft.prose} multiline editable={!blocked}
                        onChange={(prose) => setDraft((current) => current ? { ...current, prose } : null)} />
                    <SavedAction id="prose-save" label={t('common.save')} disabled={blocked || !selectedExists || !draft.prose.trim()}
                        onPress={() => edit({ kind: 'editStop', stopId: draft.stopId!, explanationMarkdown: draft.prose })} />
                    <View style={styles.actions}>
                        <SavedAction id="move-up" label={t('walkthrough.saved.moveUp')} disabled={blocked || selectedIndex <= 0} onPress={() => moveStop(-1)} />
                        <SavedAction id="move-down" label={t('walkthrough.saved.moveDown')} disabled={blocked || !nextStop} onPress={() => moveStop(1)} />
                        <SavedAction id="merge-next" label={t('walkthrough.saved.mergeNext')} disabled={blocked || !nextStop || !draft.prose.trim() || !draft.stopTitle.trim()}
                            onPress={() => nextStop ? edit({ kind: 'mergeStops', stopIds: [draft.stopId!, nextStop.id], targetStopId: draft.stopId!,
                                title: draft.stopTitle, explanationMarkdown: `${draft.prose}\n\n${nextStop.explanationMarkdown}` }) : undefined} />
                    </View>
                </> : null}
                {refining && canGenerate ? <>
                    <SavedField id="instructions" label={t('walkthrough.saved.instructions')} value={instructions} multiline editable={!blocked}
                        onChange={setInstructions} />
                    <SavedAction id="refine-send" label={t('walkthrough.saved.refine')} disabled={blocked || Boolean(draft.stopId && !selectedExists) || !instructions.trim()}
                        onPress={() => invoke(() => props.operations.refine({ ...revisionInput(draft.expectedRevision), output: 'walkthrough',
                            instructions, ...(draft.stopId ? { stopIds: [draft.stopId] } : {}) }))} />
                </> : null}
                <SavedAction id="cancel" label={t('common.cancel')} disabled={busy}
                    onPress={() => { setDraft(null); setRefining(false); setFailure(null); }} />
            </View> : null}
        </View>
    );
}

function SavedAction(props: Readonly<{ id: string; label: string; disabled?: boolean; selected?: boolean; onPress: () => void | Promise<void> }>) {
    return <RoundButton testID={`walkthrough-saved-${props.id}`} title={props.label} accessibilityLabel={props.label}
        size="small" display={props.selected ? 'secondary' : 'inverted'} titleNumberOfLines="complete" disabled={props.disabled}
        onPress={() => { if (!props.disabled) return props.onPress(); }} />;
}

function SavedField(props: Readonly<{ id: string; label: string; value: string; editable: boolean; multiline?: boolean; onChange: (value: string) => void }>) {
    const labelId = React.useId();
    return <View style={styles.field}>
        <Text nativeID={labelId} style={styles.label}>{props.label}</Text>
        <FieldTextInput testID={`walkthrough-saved-${props.id}`} accessibilityLabel={props.label} accessibilityLabelledBy={labelId}
            value={props.value} onChangeText={props.onChange} multiline={props.multiline} editable={props.editable} />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    root: { gap: PAGE_LIST_METRICS.sectionHeaderGapPx, paddingBottom: PAGE_LIST_METRICS.sectionHeaderGapPx },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: PAGE_LIST_METRICS.groupHeadingGapPx, alignItems: 'center' },
    editor: { gap: PAGE_LIST_METRICS.sectionHeaderGapPx, paddingVertical: PAGE_LIST_METRICS.rowPaddingVerticalPx },
    field: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
    label: { ...Typography.default('medium'), fontSize: FIELD_BOX_METRICS.fontSizePx, color: theme.colors.text.secondary },
    reason: { ...Typography.default(), fontSize: FIELD_BOX_METRICS.fontSizePx, color: theme.colors.text.secondary },
    error: { ...Typography.default(), fontSize: FIELD_BOX_METRICS.fontSizePx, color: theme.colors.state.danger.foreground },
    feedback: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
}));
