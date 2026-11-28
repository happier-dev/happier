import * as React from 'react';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { AccessibilityInfo, Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { WidgetSizePicker, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs';

import { useInputFieldOptions, type InputFieldOptionsRequest } from '@/components/sessions/actions/useInputFieldOptions';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX } from '@/components/ui/lists/itemGroupSpacing';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { getWidgetSizeFootprintV1, WidgetBindingResolutionV1Schema, type WidgetBindingResolutionV1 } from '@happier-dev/protocol/widgets';
import { Typography } from '@/constants/Typography';
import { useRetainedPlacement } from '@/modal/components/RetainedModalFrame';
import { t } from '@/text';
import { WidgetPreviewWell, WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { WidgetPreviewStage } from '@/components/widgets/flow/WidgetPreviewStage';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { WidgetSetupFieldRow, WidgetSetupOptionsNotice, type WidgetSetupFieldChange } from './WidgetSetupFieldRow';
import {
    describeWidgetSetupBlocker,
    describeWidgetSetupRow,
    isLiteralWidgetSetupField,
    setWidgetSetupBinding,
    widgetSetupBlockingIssues,
    type WidgetSetupStepModel,
    type WidgetSetupAdmissionResult,
    type WidgetSetupDraft,
    type WidgetSetupValue,
    type WidgetSetupSubmitResult,
} from './widgetSetupModel';
import { isNothingToChoose } from './optionSourceEmptyState';

/** The preview well keeps one height while inputs change, so the step never jumps under the pointer. */
const PREVIEW_MIN_HEIGHT_PX = 168;
/** Edit inputs' preview column: a glance at the live card, narrower than the inputs it answers to. */
const POPOVER_PREVIEW_WIDTH_PX = 288;
/** A phone shows the card's header and first rows under the inputs; the rest is clipped, never scaled. */
const PHONE_PREVIEW_HEIGHT_PX = 168;
/** Below this width the inputs and the preview column stack (a card's own popover in a rail), as on a phone. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = POPOVER_PREVIEW_WIDTH_PX + 260;

const NO_OPTIONS: readonly WidgetSetupValue[] = Object.freeze([]);
const UNRESOLVED_ADMISSION: WidgetBindingResolutionV1 = { status: 'unavailable', fields: [] };
const ADMITTED_GROUP: WidgetBindingResolutionV1 = { status: 'ready', input: {} };
/** Cancels the untitled group's top spacer, so its sheet starts at the pane's top edge. The pane owns its own
 * sides (a contained list scope), so the sheet adds no inset there to cancel with a negative margin. */
const PANE_SHEET_FLUSH = {
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
 * left. The step owns only the draft. It reads readiness from the setup's binder or placement Action.
 * The write is the canonical Action behind `setup.submit`; leaving writes nothing. The live body
 * mounts only while the step is open and the draft resolves.
 */
export function WidgetSetupStep(props: Readonly<{
    setup: WidgetSetupStepModel;
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
    /**
     * After an applied Add the pane's button reads "Add another" and returns here (to the picker)
     * instead of writing: a second copy is a deliberate choice of a widget, never a repeated press.
     */
    onAddAnother?: () => void;
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
    /** Admission of the opener's initial choices; subsequent draft changes own their reads. */
    callerContext?: ActionExecutorContext;
    /** Opened by a repair: that input's choices start open. */
    focusPath?: string;
    testID: string;
}>): React.ReactElement {
    const { setup } = props;
    const { theme } = useUnistyles();
    const [draft, setDraft] = React.useState<WidgetSetupDraft>(setup.initial);
    const [pickedOptions, setPickedOptions] = React.useState<Readonly<Record<string, readonly WidgetSetupValue[]>>>({});
    const [busy, setBusy] = React.useState(false);
    const [refusal, setRefusal] = React.useState<Extract<WidgetSetupSubmitResult, { ok: false }> | null>(null);
    // Gallery counts and server echoes rebuild entries. The unresolved invocation
    // keeps custody until its own receipt; a rebuilt entry cannot turn Retry into Add.
    const submission = React.useRef<WidgetSetupStepModel['submit'] | null>(null);
    // The Add pane stays open after acknowledgement. Approval keeps custody of
    // this request; only an applied Add offers an intentional additional copy.
    const [completion, setCompletion] = React.useState<'added' | 'approvalPending' | null>(null);
    const { readAdmission, readInherited, resolve } = setup;
    const [review, setReview] = React.useState<Readonly<{
        read: NonNullable<WidgetSetupStepModel['readAdmission']>; draft: WidgetSetupDraft; result: WidgetSetupAdmissionResult;
    }> | null>(null);
    React.useEffect(() => {
        if (!readAdmission) return;
        const controller = new AbortController();
        void readAdmission(draft, controller.signal).then(result => {
            if (!controller.signal.aborted) setReview({ read: readAdmission, draft, result });
        });
        return () => controller.abort();
    }, [draft, readAdmission]);
    const admission = review && review.read === readAdmission && review.draft === draft ? review.result : undefined;
    const resolution = React.useMemo(() => {
        if (resolve) return resolve(draft);
        if (admission?.ok) return ADMITTED_GROUP;
        const details = admission?.details;
        if (details && typeof details === 'object' && 'status' in details && 'fields' in details) {
            const parsed = WidgetBindingResolutionV1Schema.safeParse({ status: details.status, fields: details.fields });
            if (parsed.success && parsed.data.status !== 'ready') return parsed.data;
        }
        return UNRESOLVED_ADMISSION;
    }, [admission, draft, resolve]);
    const { bindings } = draft;
    const inherited = React.useMemo(() => readInherited?.(bindings), [readInherited, bindings]);
    const admissionDetails = admission?.ok === false ? admission.details : undefined;
    const decidingPath = admissionDetails && typeof admissionDetails === 'object' && 'blockingFieldPath' in admissionDetails
        && typeof admissionDetails.blockingFieldPath === 'string' ? admissionDetails.blockingFieldPath : undefined;
    const blocker = describeWidgetSetupBlocker(setup.fields, resolution, decidingPath);
    // Finishable once nothing blocks; a per-viewer input is each viewer's own and never blocks.
    const finishable = completion !== 'approvalPending'
        && (readAdmission ? admission === null || admission?.ok === true : widgetSetupBlockingIssues(setup.fields, resolution).length === 0)
        && (!props.blockedReason || submission.current !== null);
    const pane = props.presentation === 'pane';
    const offersAnother = pane && completion === 'added' && props.onAddAnother !== undefined;

    // Choices come from the one options resolver, read only while this step is open.
    const discoveryContext = React.useMemo(() => setup.optionsContext?.(draft), [draft, setup]);
    const consumer = discoveryContext?.consumer;
    const selectedSession = consumer?.kind === 'widget' ? consumer.selectedSession : undefined;
    const appRuntime = useAppShellPluginUiProjection(value => ({
        machineId: value.machineId,
        pluginUiProjection: value.pluginUiProjection,
        accountLifetime: value.accountLifetime,
    }));
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
        initialCallerContext: draft === setup.initial ? props.callerContext : undefined,
        ...(optionServerId ? { serverId: optionServerId } : {}),
        ...(selectedSession ? { sessionId: selectedSession.sessionId } : {}),
        ...(!selectedSession ? { pluginUiMachineId: appRuntime.machineId, pluginUiProjection: appRuntime.pluginUiProjection,
            accountLifetime: appRuntime.accountLifetime } : {}),
    });

    const change = React.useCallback((path: string, next: WidgetSetupFieldChange) => {
        setRefusal(null);
        const request = requests.find(request => request.field.path === path);
        const offered = request ? options.state(request.field, request).options : [];
        setPickedOptions(current => ({ ...current, [path]: next.kind === 'pin'
            ? [...offered, ...(current[path] ?? [])].filter(option => sameStrictJsonValue(option.value, next.value)
                || Array.isArray(next.value) && next.value.some(value => sameStrictJsonValue(option.value, value)))
                .filter((option, index, all) => all.findIndex(candidate => sameStrictJsonValue(candidate.value, option.value)) === index)
                .map(option => ({ value: option.value as JsonValue, label: option.label })) : [] }));
        setDraft((current) => setWidgetSetupBinding(current, path, next));
    }, [options.state, requests]);

    const submit = React.useCallback(async () => {
        if (offersAnother) { props.onAddAnother?.(); return; }
        if (busy || !finishable) return;
        setBusy(true);
        setRefusal(null);
        try {
            submission.current ??= setup.submit;
            const result = await submission.current(draft);
            if (result.ok) {
                submission.current = null;
                AccessibilityInfo.announceForAccessibility?.(result.approvalPending ? t('widgetAdd.areaApprovalPending') : t('widgetAdd.saved', { widget: setup.title }));
                setCompletion(result.approvalPending ? 'approvalPending' : 'added');
                props.onDone(result);
                return;
            }
            setRefusal(result);
            props.onRefused?.(result.message);
        } catch (error) {
            const message = resolveActionExecutionErrorMessage(error, t('widgetAdd.saveFailed'));
            setRefusal({ ok: false, message });
            props.onRefused?.(message);
        } finally {
            setBusy(false);
        }
    }, [busy, draft, finishable, offersAnother, props, setup]);
    // The first needed input asked for the focus, and how many times (each ask moves it again).
    const [focusRequest, setFocusRequest] = React.useState<Readonly<{ path: string; count: number }> | null>(null);
    const blockerPath = blocker?.path ?? null;
    const { commandRef } = props;
    React.useEffect(() => {
        if (!commandRef) return undefined;
        commandRef.current = () => {
            if (finishable || offersAnother) { void submit(); return; }
            if (blockerPath) setFocusRequest((current) => ({ path: blockerPath, count: (current?.count ?? 0) + 1 }));
        };
        return () => { commandRef.current = null; };
    }, [blockerPath, commandRef, finishable, offersAnother, submit]);

    // The fields' own predicates over the current draft (shown, required, disabled), from the one
    // neutral field owner: a hidden input leaves the step and a disabled one cannot be changed.
    const draftInput = discoveryContext?.draftInput;
    const effective = React.useMemo(() => new Map(resolveEffectiveInputFields(
        { inputHints: { fields: setup.fields.map(({ field }) => field) } }, draftInput ?? {}, { includeHidden: true, contextSlots: setup.contextSlots },
    ).map((field) => [field.path, field])), [draftInput, setup.fields, setup.contextSlots]);
    const fields = setup.fields.flatMap((entry, index) => {
        const facts = effective.get(entry.field.path);
        return facts && !facts.visible ? [] : [{ entry, index, facts }];
    });
    const sizes = setup.sizeChoices;
    const widths = setup.widthChoices;
    const draftCommands: CurrentUiContextLocalCommand[] = fields.flatMap(({ entry, facts }) => {
        if (busy || facts?.disabled || entry.viewer) return [];
        const { path } = entry.field;
        const title = `${setup.title}: ${entry.field.prompt ?? entry.field.title}`;
        return [
            { key: `field:${path}`, title, invoke: value => {
                if (value === undefined) return false;
                change(path, { kind: 'pin', value });
            } },
            { key: `clear:${path}`, title: `${t('selectionList.clearInput')}: ${title}`, invoke: () => change(path, { kind: 'clear' }) },
            ...(entry.follow ? [{ key: `follow:${path}`, title: `${entry.follow.label}: ${title}`,
                invoke: () => change(path, { kind: 'follow', slot: entry.follow!.slot }) }] : []),
        ];
    });
    const commands = useCurrentUiContextLocalCommands([
        ...draftCommands,
        ...(!busy && sizes && draft.size ? [{ key: 'size', title: `${setup.title}: ${t('widgetAdd.size')}`,
            invoke: (value?: import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1) => {
                const size = sizes.sizes.find(size => size === value);
                if (!size) return false;
                setRefusal(null); setDraft(current => ({ ...current, size }));
            } }] : []),
        ...(!busy && widths && draft.width ? [{ key: 'width', title: `${setup.title}: ${t('widgetFrame.groupWidth')}`,
            invoke: (value?: import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1) => {
                const choice = widths.find(choice => choice.width === value && !choice.unavailableReason);
                if (!choice) return false;
                setRefusal(null); setDraft(current => ({ ...current, width: choice.width }));
            } }] : []),
    ], { unbound: 'local' });

    // The inputs share one choices read: a failure is said once, above them, with the one Retry.
    const optionsFailed = fields.some(({ index }) => {
        const request = requests[index]!;
        return options.state(request.field, request).status === 'failed';
    });
    const inputs = (
        <InputTypePickerHostProvider enabled={setup.fields.some(({ field }) => field.inputType !== undefined)}
            {...options.resolveOptions.pickerContext}
            contextKey={JSON.stringify([consumer, draft, options.snapshot])}>
        <CoreCollectionScope>
        <ListPresentationProvider value="page" {...(pane ? { pageInsets: 'contained' as const } : {})}>
            {optionsFailed ? <WidgetSetupOptionsNotice label={setup.title} onRetry={options.retry} disabled={busy}
                testID={`${props.testID}.optionsFailed`} /> : null}
            {/* In the Add pane the inputs' sheet shares the title's and the preview's edges (lab A2/A2p). */}
            <ItemGroup surface={pane ? 'sheet' : 'none'} density="compact" {...(pane ? { style: PANE_SHEET_FLUSH } : {})}>
                {fields.map(({ entry, index, facts }) => {
                    const request = requests[index]!;
                    const state = options.state(request.field, request);
                    const values = state.options.length === 0 ? NO_OPTIONS : state.options.map((option): WidgetSetupValue => ({
                        value: option.value as JsonValue,
                        label: option.label,
                        ...(option.description ? { description: option.description } : {}),
                        ...(option.disabled ? { disabled: true } : {}),
                    }));
                    const binding = draft.bindings[entry.field.path];
                    const field = facts ? { ...entry.field, required: facts.required } : entry.field;
                    const reading = inherited?.get(field.path);
                    const setupField = field === entry.field && !reading ? entry : { ...entry, field, ...(reading ? { inherited: reading } : {}) };
                    const row = describeWidgetSetupRow({ entry: setupField, draft, resolution, options: values, pickedOptions: pickedOptions[field.path] });
                    return (
                        <WidgetSetupFieldRow
                            key={entry.field.path}
                            testID={`${props.testID}.field.${entry.field.path}`}
                            entry={setupField}
                            row={row}
                            options={values}
                            optionsStatus={state.status}
                            plainValue={binding?.kind === 'value' ? binding.value : undefined}
                            phone={props.phone}
                            autoOpen={props.focusPath === entry.field.path}
                            {...(focusRequest?.path === entry.field.path ? { focusRequest: focusRequest.count } : {})}
                            disabled={busy || facts?.disabled === true}
                            onChange={next => { void commands.invoke(`${next.kind === 'pin' ? 'field' : next.kind}:${entry.field.path}`,
                                next.kind === 'pin' ? next.value : undefined); }}
                        />
                    );
                })}
            </ItemGroup>
        </ListPresentationProvider>
        </CoreCollectionScope>
        </InputTypePickerHostProvider>
    );

    // The live widget mounts only while the step is open and its inputs resolve. A surface that can
    // only preview with its own authority returns nothing for another target, and a per-viewer input
    // only resolves for each viewer once added; the card then says what it waits for rather than
    // drawing someone else's data.
    const live = resolution.status === 'ready' && setup.renderPreview
        ? setup.renderPreview({ input: resolution.input, draft, ...(refusal ? { refusal } : {}) }) : null;
    // The input that blocks may have nothing to choose yet: its row says so, and the preview and footer say nothing
    // more (one message per state; DESIGN-1118-B Delta 1). The footer's Add stays disabled.
    const blockerIndex = blocker ? setup.fields.findIndex((entry) => entry.field.path === blocker.path) : -1;
    const blockerEntry = blockerIndex >= 0 ? setup.fields[blockerIndex] : undefined;
    const blockerRequest = blockerIndex >= 0 ? requests[blockerIndex] : undefined;
    const blockerState = blockerEntry && blockerRequest ? options.state(blockerRequest.field, blockerRequest) : null;
    const blockerBinding = blockerEntry ? draft.bindings[blockerEntry.field.path] : undefined;
    const blockerSaidOnRow = !!blockerEntry && !!blockerState && isNothingToChoose({ field: blockerEntry.field,
        optionsStatus: blockerState.status, optionCount: blockerState.options.length,
        value: blockerBinding?.kind === 'value' ? blockerBinding.value : undefined, follows: blockerBinding?.kind === 'context' });
    const admissionNotice = readAdmission && admission === undefined ? t('common.loading') : admission?.ok === false ? admission.message : null;
    const neededNotice = blocker && (blocker.status === 'selection_required' || !admissionNotice)
        ? t('widgetAdd.stillNeeded', { field: blocker.title }) : null;
    const waitingText = blockerSaidOnRow ? '' : admissionNotice && !blocker ? admissionNotice : finishable || props.blockedReason ? t('widgetAdd.previewAfterAdd')
        : t('widgetAdd.previewWaiting', { field: blocker?.title ?? setup.fields[0]?.field.title ?? '' });
    // A group's width as the same footprint a size has: one or both of the surface's two columns.
    const widthFootprint = (width: 'half' | 'full') => ({ columns: 2, columnSpan: width === 'half' ? 1 : 2, rowSpan: 1 });
    const unavailableWidth = widths?.find(choice => choice.unavailableReason);
    const sizePicker = sizes && draft.size ? <WidgetSizeControl
        testID={`${props.testID}.size`} showLabel={!pane} flush={!pane} surface={sizes.surface} sizes={sizes.sizes}
        size={draft.size} disabled={busy} onSet={size => { void commands.invoke('size', size); }} />
        // A saved group offers its width only (lab wgsaved A): the same picker, Half | Full.
        : widths && draft.width ? <View style={styles.widthPicker}>
            <WidgetSizePicker testID={`${props.testID}.width`} accessibilityLabel={t('widgetFrame.groupWidth')} value={draft.width} disabled={busy}
                choices={widths.map(choice => ({ key: choice.width, label: t(choice.width === 'half' ? 'widgetFrame.widthHalf' : 'widgetFrame.widthFull'),
                    footprint: widthFootprint(choice.width), ...(choice.unavailableReason ? { unavailable: true } : {}) }))}
                colors={{ track: theme.colors.segmentedControl.trackBackground, thumb: theme.colors.segmentedControl.activeBackground,
                    label: theme.colors.text.secondary, activeLabel: theme.colors.text.primary, focusRing: theme.colors.border.focus }}
                onChange={key => { void commands.invoke('width', key); }} />
            {unavailableWidth?.unavailableReason ? <Text style={styles.waiting} testID={`${props.testID}.width.unavailable`}>{unavailableWidth.unavailableReason}</Text> : null}
        </View> : null;
    const widgetTitle = setup.widget?.title ?? setup.title;
    const [bodyWidth, setBodyWidth] = React.useState(0);
    const stacked = props.phone === true || (bodyWidth > 0 && bodyWidth < SIDE_BY_SIDE_MIN_WIDTH_PX);
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
                        {waitingText ? <Text style={styles.waiting} testID={`${props.testID}.previewWaiting`}>{waitingText}</Text> : null}
                    </View>
                ),
            }}
        />
    ) : null;
    const retainedPreview = useRetainedPlacement<null>(() => card);
    const preview = card ? (
        pane && !props.phone ? (
            // A mounted preview can still be loading or refused. Its body owns the read state.
            <WidgetPreviewStage testID={`${props.testID}.preview`} surface={sizes?.surface ?? null} size={draft.size}
                {...(widths && draft.width ? { footprint: widthFootprint(draft.width), alone: true } : {})}
                caption={t('widgetAdd.preview')} accessibilityLabel={widgetTitle}>{retainedPreview.mount(null)}</WidgetPreviewStage>
        ) : (
            <WidgetPreviewWell
                testID={`${props.testID}.preview`}
                caption={t('widgetAdd.preview')}
                // The card has its own edge; only a fixed-height clip (Edit inputs on a phone) keeps a plate behind it.
                framed
                // The Add pane on a phone shows the whole compact card; Edit inputs keeps its fixed room.
                {...(props.phone ? (pane ? {} : { height: PHONE_PREVIEW_HEIGHT_PX }) : { minHeight: PREVIEW_MIN_HEIGHT_PX })}
            >
                {retainedPreview.mount(null)}
            </WidgetPreviewWell>
        )
    ) : null;
    // What Add will do, until an outcome takes the line (lab wsplit A1).
    const { describeOutcome } = setup;
    const outcome = React.useMemo(() => pane && finishable ? describeOutcome?.(draft) : undefined,
        [pane, finishable, describeOutcome, draft]);
    const consequence = outcome ?? (pane && finishable && draft.size ? t('widgetAdd.addsAtSize', { size: t(`widgetAdd.sizes.${draft.size}`) })
        : pane && finishable && draft.width ? t('widgetFrame.addsAtWidth', { width: t(draft.width === 'half' ? 'widgetFrame.widthHalf' : 'widgetFrame.widthFull') }) : null);

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
        error: refusal?.message ?? null,
        note: blockerSaidOnRow ? null : neededNotice ?? admissionNotice ?? props.blockedReason ?? props.notice ?? consequence,
        ...(props.backLabel ? { backLabel: props.backLabel } : {}),
        primary: {
            testID: `${props.testID}.submit`,
            label: pane && completion === 'added' ? t('widgetAdd.addAnother') : setup.submitLabel,
            ...(pane ? { icon: 'plus' as const } : {}),
            onPress: () => { void submit(); },
            disabled: !offersAnother && (busy || !finishable),
            busy,
            busyNote: pane ? t('widgetAdd.adding') : t('widgetAdd.savingInputs'),
        },
    } satisfies Omit<React.ComponentProps<typeof WidgetFlowPanel>, 'children'>;

    if (pane) {
        // Inputs first, then the stage with the size under the card (lab wsplit A1/A2).
        return (
            <WidgetFlowPanel {...panel}>
                {retainedPreview.body}
                <ScrollView style={styles.paneScroll} contentContainerStyle={props.phone ? styles.bodyPhone : styles.paneBody}
                    keyboardShouldPersistTaps="always" testID={`${props.testID}.scroll`}>
                    {setup.fields.length > 0 ? inputs : null}
                    {preview}
                    {sizePicker ? <View style={props.phone ? undefined : styles.paneSize}>{sizePicker}</View> : null}
                </ScrollView>
            </WidgetFlowPanel>
        );
    }
    const aside = preview && sizePicker ? <View style={{ gap: theme.space.s12 }}>{preview}{sizePicker}</View> : preview ?? sizePicker;
    return (
        <WidgetFlowPanel {...panel}>
            {retainedPreview.body}
            <View style={stacked || setup.fields.length === 0 || !aside ? styles.bodyPhone : styles.body}
                onLayout={(event) => setBodyWidth(Math.round(event.nativeEvent.layout.width))}>
                {setup.fields.length > 0 ? <View style={stacked || !aside ? undefined : styles.inputs}>{inputs}</View> : null}
                {aside ? <View style={stacked || setup.fields.length === 0 ? undefined : styles.previewColumn}>{aside}</View> : null}
            </View>
        </WidgetFlowPanel>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s12 },
    bodyPhone: { gap: theme.space.s6 },
    // The inputs keep the room their label and value need; the preview is a fixed glance beside
    // them and never paints over a value (QA-V F11). Anything wider wraps inside its own column.
    inputs: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, overflow: 'hidden' },
    previewColumn: { width: POPOVER_PREVIEW_WIDTH_PX, flexShrink: 0, paddingTop: theme.space.s2 },
    paneScroll: { flex: 1, minHeight: 0 },
    paneBody: { flexGrow: 1, gap: theme.space.s12 },
    paneSize: { alignItems: 'center' },
    widthPicker: { alignItems: 'center', gap: theme.space.s6 },
    // The card's reserved rows while its inputs are still being chosen: what it waits for, quiet.
    waitingBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.s8, paddingBottom: theme.space.s4 },
    waiting: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
        textAlign: 'center',
    },
}));
