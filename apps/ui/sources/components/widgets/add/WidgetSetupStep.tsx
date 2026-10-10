import * as React from 'react';
import { AccessibilityInfo, Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { WidgetSizePicker, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue } from '@happier-dev/protocol';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs';

import { useInputFieldOptions, type InputFieldOptionsRequest } from '@/components/sessions/actions/useInputFieldOptions';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX, resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WidgetPreviewWell, WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { WidgetPreviewStage } from '@/components/widgets/flow/WidgetPreviewStage';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';

import { WidgetSetupFieldRow, type WidgetSetupFieldChange } from './WidgetSetupFieldRow';
import {
    describeWidgetSetupBlocker,
    describeWidgetSetupRow,
    isLiteralWidgetSetupField,
    setWidgetSetupBinding,
    widgetSetupBlockingIssues,
    type WidgetSetup,
    type WidgetSetupDraft,
    type WidgetSetupValue,
    type WidgetSetupSubmitResult,
} from './widgetSetupModel';

/** The preview well keeps one height while inputs change, so the step never jumps under the pointer. */
const PREVIEW_MIN_HEIGHT_PX = 168;
/** A phone shows the card's header and first rows under the inputs; the rest is clipped, never scaled. */
const PHONE_PREVIEW_HEIGHT_PX = 168;

const NO_OPTIONS: readonly WidgetSetupValue[] = Object.freeze([]);
/** Cancels the untitled group's own inset and top spacer, so its sheet starts at the pane's edges. */
const PANE_SHEET_FLUSH = {
    marginHorizontal: -resolveItemGroupContentHorizontalInsetPx(),
    marginTop: -(Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX) ?? 0),
} as const;

/**
 * One widget's inputs, live body and size, then one button (lab `widget-add` wsplit A, `dashboards`
 * dbind E/X). Two compositions:
 *
 * - `pane`: the Add surface's right side. The widget's mark, title, purpose and provenance; inputs
 *   first; then the real card at its real size on this surface with the size picker under it; and
 *   one footer: a quiet line and Add. No Cancel: the surface closes from its ×, or Back on a phone.
 * - `popover` (Edit inputs, in-card repair): inputs left and the preview beside them, Cancel and Save.
 *
 * On phones the inputs come first and a compact preview follows. The button says where it goes
 * ("Add to Home") or "Save"; while something is still needed it stays off and the line says what is
 * left. The step owns only the draft. Admission is the binder's (`setup.resolve`, run on every change)
 * and the write is the canonical Action behind `setup.submit`; leaving writes nothing. The live body
 * mounts only while the step is open and the draft resolves.
 */
export function WidgetSetupStep(props: Readonly<{
    setup: WidgetSetup;
    phone: boolean;
    presentation?: 'pane' | 'popover';
    /** Back to the list (the narrow Add surface and phones); absent for Edit inputs and in-card repair. */
    onBack?: () => void;
    /** Where Back goes, named beside its caret on a phone ("Widgets"). */
    backLabel?: string;
    /** Edit inputs and repair; the Add pane has none. */
    onCancel?: () => void;
    /** Edit inputs on a phone: the header caret closes the sheet (lab Ep), as Cancel does on desktop. */
    onClose?: () => void;
    /** After the Action acknowledged the write or retained it for approval. */
    onDone: (result: Extract<WidgetSetupSubmitResult, { ok: true }>) => void;
    /** The Action refused; the step keeps the reason on its line and the button retries. */
    onRefused?: (message: string) => void;
    /** What became of the last Add, said on the step's line until the next one (the Add surface's outcome). */
    notice?: string | null;
    /** The button cannot add this one again ("Added": a second copy would show the same thing). */
    blockedReason?: string | null;
    /** Quiet help just before the button (⌘↵). */
    footerAccessory?: React.ReactNode;
    /**
     * The surface's ⌘↵ and ↵: the button's submit once nothing is needed, otherwise the focus moves
     * to the first input still needed.
     */
    commandRef?: React.MutableRefObject<(() => void) | null>;
    /** Exact Home/session identity for option reads (never ambient). */
    serverId?: string | null;
    sessionId?: string | null;
    /** Opened by a repair: that input's choices start open. */
    focusPath?: string;
    testID: string;
}>): React.ReactElement {
    const { setup } = props;
    const { theme } = useUnistyles();
    const [draft, setDraft] = React.useState<WidgetSetupDraft>(setup.initial);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const resolution = React.useMemo(() => setup.resolve(draft), [draft, setup]);
    const blocker = describeWidgetSetupBlocker(setup.fields, resolution);
    // Finishable once nothing blocks; a per-viewer input is each viewer's own and never blocks.
    const finishable = widgetSetupBlockingIssues(setup.fields, resolution).length === 0 && !props.blockedReason;
    const pane = props.presentation === 'pane';

    // Choices come from the one options resolver, read only while this step is open.
    const discoveryContext = React.useMemo(() => setup.optionsContext?.(draft), [draft, setup]);
    const consumer = discoveryContext?.consumer;
    const selectedSession = consumer?.kind === 'widget' ? consumer.selectedSession : undefined;
    const optionServerId = selectedSession?.serverId ?? props.serverId;
    const requests = React.useMemo<InputFieldOptionsRequest[]>(() => setup.fields.map(({ field, viewer }) => ({
        ...setup.optionsContext?.(draft, field),
        // Viewer discovery belongs to Connect. Literals without a declared source use the
        // public parser/picker, not an unused choices read merely because they name a type.
        field: viewer || (isLiteralWidgetSetupField(field) && field.optionsSourceId === undefined && field.connectedAccountOptions !== true)
            ? { path: field.path, ...(field.options ? { options: field.options } : {}) } : field,
    })), [draft, setup]);
    const options = useInputFieldOptions({
        requests,
        enabled: true,
        ...(optionServerId ? { serverId: optionServerId } : {}),
        ...(selectedSession ? { sessionId: selectedSession.sessionId } : {}),
    });

    const change = React.useCallback((path: string, next: WidgetSetupFieldChange) => {
        setError(null);
        setDraft((current) => setWidgetSetupBinding(current, path, next));
    }, []);

    const submit = React.useCallback(async () => {
        if (busy || !finishable) return;
        setBusy(true);
        setError(null);
        try {
            const result = await setup.submit(draft);
            if (result.ok) {
                AccessibilityInfo.announceForAccessibility?.(result.approvalPending ? t('widgetAdd.areaApprovalPending') : t('widgetAdd.saved', { widget: setup.title }));
                props.onDone(result);
                return;
            }
            setError(result.message);
            props.onRefused?.(result.message);
        } catch {
            setError(t('widgetAdd.saveFailed'));
            props.onRefused?.(t('widgetAdd.saveFailed'));
        } finally {
            setBusy(false);
        }
    }, [busy, draft, finishable, props, setup]);
    // The first needed input asked for the focus, and how many times (each ask moves it again).
    const [focusRequest, setFocusRequest] = React.useState<Readonly<{ path: string; count: number }> | null>(null);
    const blockerPath = blocker?.path ?? null;
    const { commandRef } = props;
    React.useEffect(() => {
        if (!commandRef) return undefined;
        commandRef.current = () => {
            if (finishable) { void submit(); return; }
            if (blockerPath) setFocusRequest((current) => ({ path: blockerPath, count: (current?.count ?? 0) + 1 }));
        };
        return () => { commandRef.current = null; };
    }, [blockerPath, commandRef, finishable, submit]);

    // The fields' own predicates over the current draft (shown, required, disabled), from the one
    // neutral field owner: a hidden input leaves the step and a disabled one cannot be changed.
    const draftInput = discoveryContext?.draftInput;
    const effective = React.useMemo(() => new Map(resolveEffectiveInputFields(
        { inputHints: { fields: setup.fields.map(({ field }) => field) } }, draftInput ?? {}, { includeHidden: true },
    ).map((field) => [field.path, field])), [draftInput, setup.fields]);

    // The values the draft is bound to, as their rows name them, for the line that says what Add does.
    const boundValues = setup.describeOutcome ? setup.fields.flatMap((entry, index) => {
        const request = requests[index]!;
        const row = describeWidgetSetupRow({ entry, draft, resolution, options: options.state(request.field, request).options.map((option): WidgetSetupValue => ({
            value: option.value as JsonValue, label: option.label })) });
        const label = row.kind === 'pinned' ? row.value?.label ?? row.label : row.kind === 'follows' ? row.valueLabel ?? row.label : null;
        return label ? [label] : [];
    }) : [];

    const inputs = (
        <InputTypePickerHostProvider enabled={setup.fields.some(({ field }) => field.inputType !== undefined)}
            {...options.resolveOptions.pickerContext}
            contextKey={JSON.stringify([consumer, draft, options.snapshot])}>
        <ListPresentationProvider value="page">
            {/* In the Add pane the inputs' sheet shares the title's and the preview's edges (lab A2/A2p). */}
            <ItemGroup surface={pane ? 'sheet' : 'none'} density="compact" {...(pane ? { style: PANE_SHEET_FLUSH } : {})}>
                {setup.fields.map((entry, index) => {
                    const facts = effective.get(entry.field.path);
                    if (facts && !facts.visible) return null;
                    const request = requests[index]!;
                    const state = options.state(request.field, request);
                    const values = state.options.length === 0 ? NO_OPTIONS : state.options.map((option): WidgetSetupValue => ({
                        value: option.value as JsonValue,
                        label: option.label,
                        ...(option.description ? { description: option.description } : {}),
                        ...(option.disabled ? { disabled: true } : {}),
                    }));
                    const row = describeWidgetSetupRow({ entry, draft, resolution, options: values });
                    const binding = draft.bindings[entry.field.path];
                    const field = facts ? { ...entry.field, required: facts.required } : entry.field;
                    return (
                        <WidgetSetupFieldRow
                            key={entry.field.path}
                            testID={`${props.testID}.field.${entry.field.path}`}
                            entry={field === entry.field ? entry : { ...entry, field }}
                            row={row}
                            options={values}
                            optionsStatus={state.status}
                            onRetryOptions={options.retry}
                            plainValue={binding?.kind === 'value' ? binding.value : undefined}
                            phone={props.phone}
                            autoOpen={props.focusPath === entry.field.path}
                            {...(focusRequest?.path === entry.field.path ? { focusRequest: focusRequest.count } : {})}
                            disabled={busy || facts?.disabled === true}
                            onChange={(next) => change(entry.field.path, next)}
                        />
                    );
                })}
            </ItemGroup>
        </ListPresentationProvider>
        </InputTypePickerHostProvider>
    );

    // The live widget mounts only while the step is open and its inputs resolve. A surface that can
    // only preview with its own authority returns nothing for another target, and a per-viewer input
    // only resolves for each viewer once added; the card then says what it waits for rather than
    // drawing someone else's data.
    const live = resolution.status === 'ready' && setup.renderPreview ? setup.renderPreview({ input: resolution.input, draft }) : null;
    const waitingText = finishable || props.blockedReason ? t('widgetAdd.previewAfterAdd')
        : t('widgetAdd.previewWaiting', { field: blocker?.title ?? setup.fields[0]?.field.title ?? '' });
    const sizes = setup.sizeChoices;
    const widths = setup.widthChoices;
    // A group's width as the same footprint a size has: one or both of the surface's two columns.
    const widthFootprint = (width: 'half' | 'full') => ({ columns: 2, columnSpan: width === 'half' ? 1 : 2, rowSpan: 1 });
    const unavailableWidth = widths?.find(choice => choice.unavailableReason);
    const sizePicker = sizes && draft.size ? <WidgetSizeControl
        testID={`${props.testID}.size`} showLabel={!pane} surface={sizes.surface} sizes={sizes.sizes}
        size={draft.size} disabled={busy} onSet={size => { setError(null); setDraft(current => ({ ...current, size })); }} />
        // A saved group offers its width only (lab wgsaved A): the same picker, Half | Full.
        : widths && draft.width ? <View style={styles.widthPicker}>
            <WidgetSizePicker testID={`${props.testID}.width`} accessibilityLabel={t('widgetFrame.groupWidth')} value={draft.width} disabled={busy}
                choices={widths.map(choice => ({ key: choice.width, label: t(choice.width === 'half' ? 'widgetFrame.widthHalf' : 'widgetFrame.widthFull'),
                    footprint: widthFootprint(choice.width), ...(choice.unavailableReason ? { unavailable: true } : {}) }))}
                colors={{ track: theme.colors.segmentedControl.trackBackground, thumb: theme.colors.segmentedControl.activeBackground,
                    label: theme.colors.text.secondary, activeLabel: theme.colors.text.primary, focusRing: theme.colors.border.focus }}
                onChange={key => {
                    const choice = widths.find(entry => entry.width === key);
                    if (!choice || choice.unavailableReason) return;
                    setError(null);
                    setDraft(current => ({ ...current, width: choice.width }));
                }} />
            {unavailableWidth?.unavailableReason ? <Text style={styles.waiting} testID={`${props.testID}.width.unavailable`}>{unavailableWidth.unavailableReason}</Text> : null}
        </View> : null;
    const widgetTitle = setup.widget?.title ?? setup.title;
    // The card at its size on this surface: a grid surface lends it the footprint's rows, a column
    // (Companion, Project aside) its compact frame.
    // A phone shows a card still waiting for its inputs at its smallest declared footprint (lab A2p);
    // once it reads, the card takes its chosen size.
    const compactWaiting = props.phone === true && pane && !live;
    const shownSize = compactWaiting ? sizes?.sizes[0] : draft.size;
    const footprint = sizes && shownSize ? getWidgetSizeFootprintV1(sizes.surface, shownSize) : undefined;
    const card = setup.renderWaitingPreview
        // Its own frame (a saved group): live once it resolves, the same frame waiting until then.
        ? live ?? setup.renderWaitingPreview({ draft, waiting: waitingText })
        : setup.renderPreview ? (
        <WidgetFrame
            testID={`${props.testID}.previewCard`}
            frameStyle="card"
            placement={footprint ? 'home' : 'companion'}
            {...(footprint && shownSize ? { widgetPresentation: { size: shownSize, footprint } } : {})}
            mark={setup.widget?.mark ?? 'squares-four'}
            title={widgetTitle}
            {...(setup.widget?.source ? { source: setup.widget.source } : {})}
            body={live ? { kind: 'content', children: live } : {
                kind: 'content',
                // What it waits for, centred in the card's room under its own mark (lab A2).
                children: (
                    <View style={styles.waitingBody}>
                        <Icon name={setup.widget?.mark ?? 'squares-four'} size={ICON_SIZE.md} color={theme.colors.text.tertiary} />
                        <Text style={styles.waiting} testID={`${props.testID}.previewWaiting`}>{waitingText}</Text>
                    </View>
                ),
            }}
        />
    ) : null;
    const preview = card ? (
        pane && !props.phone ? (
            <WidgetPreviewStage testID={`${props.testID}.preview`} surface={sizes?.surface ?? null} size={draft.size} live={live !== null}
                {...(widths && draft.width ? { footprint: widthFootprint(draft.width), alone: true } : {})}
                caption={live ? t('widgetAdd.previewLiveData') : t('widgetAdd.preview')} accessibilityLabel={widgetTitle}>{card}</WidgetPreviewStage>
        ) : (
            <WidgetPreviewWell
                testID={`${props.testID}.preview`}
                caption={pane && live ? t('widgetAdd.previewLiveData') : live ? t('widgetAdd.previewLive') : t('widgetAdd.preview')}
                // The Add pane on a phone shows the whole compact card; Edit inputs keeps its fixed room.
                {...(props.phone ? (pane ? {} : { height: PHONE_PREVIEW_HEIGHT_PX }) : { minHeight: PREVIEW_MIN_HEIGHT_PX })}
            >
                {card}
            </WidgetPreviewWell>
        )
    ) : null;
    // What Add will do, until an outcome takes the line (lab wsplit A1).
    const consequence = pane && finishable && setup.describeOutcome ? setup.describeOutcome({ draft, values: boundValues })
        : pane && finishable && draft.size ? t('widgetAdd.addsAtSize', { size: t(`widgetAdd.sizes.${draft.size}`) })
        : pane && finishable && draft.width ? t('widgetFrame.addsAtWidth', { width: t(draft.width === 'half' ? 'widgetFrame.widthHalf' : 'widgetFrame.widthFull') }) : null;

    const panel = {
        testID: props.testID,
        phone: props.phone,
        title: setup.title,
        hint: setup.hint ?? null,
        ...(pane ? { provenance: setup.provenance ?? null, mark: setup.widget?.mark ?? 'squares-four', fill: !props.phone } : {}),
        ...(props.onBack ? { onBack: props.onBack } : {}),
        ...(props.onClose ? { onClose: props.onClose } : {}),
        ...(props.onCancel ? { onCancel: props.onCancel } : {}),
        ...(props.footerAccessory && finishable ? { footerAccessory: props.footerAccessory } : {}),
        noteTestID: `${props.testID}.why`,
        error,
        note: blocker ? t('widgetAdd.stillNeeded', { field: blocker.title }) : props.blockedReason ?? props.notice ?? consequence,
        ...(props.backLabel ? { backLabel: props.backLabel } : {}),
        primary: {
            testID: `${props.testID}.submit`,
            label: setup.submitLabel,
            ...(pane ? { icon: 'plus' as const } : {}),
            onPress: () => { void submit(); },
            disabled: !finishable,
            busy,
        },
    } satisfies Omit<React.ComponentProps<typeof WidgetFlowPanel>, 'children'>;

    if (pane) {
        // Inputs first, then the stage with the size under the card (lab wsplit A1/A2).
        return (
            <WidgetFlowPanel {...panel}>
                {props.phone ? (
                    <View style={styles.bodyPhone}>
                        {setup.fields.length > 0 ? inputs : null}
                        {preview}
                        {sizePicker}
                    </View>
                ) : (
                    // One scroller for the pane: every input is whole, the stage keeps its room, and
                    // more inputs than fit scroll with the preview instead of being cut (lab wsplit A).
                    <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneBody} keyboardShouldPersistTaps="always"
                        testID={`${props.testID}.scroll`}>
                        {setup.fields.length > 0 ? inputs : null}
                        {preview}
                        {sizePicker ? <View style={styles.paneSize}>{sizePicker}</View> : null}
                    </ScrollView>
                )}
            </WidgetFlowPanel>
        );
    }
    const aside = preview && sizePicker ? <View style={{ gap: 12 }}>{preview}{sizePicker}</View> : preview ?? sizePicker;
    return (
        <WidgetFlowPanel {...panel}>
            {props.phone ? (
                <View style={styles.bodyPhone}>
                    {inputs}
                    {aside}
                </View>
            ) : aside ? (
                <View style={styles.body}>
                    <View style={styles.inputs}>{inputs}</View>
                    <View style={styles.previewColumn}>{aside}</View>
                </View>
            ) : inputs}
        </WidgetFlowPanel>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
    bodyPhone: { gap: 6 },
    inputs: { flexGrow: 1.25, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    previewColumn: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, paddingTop: 2 },
    paneScroll: { flex: 1, minHeight: 0 },
    paneBody: { flexGrow: 1, gap: 12 },
    paneSize: { alignItems: 'center' },
    widthPicker: { alignItems: 'center', gap: 6 },
    // The card's reserved rows while its inputs are still being chosen: what it waits for, quiet.
    waitingBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingBottom: 4 },
    waiting: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
        textAlign: 'center',
    },
}));
