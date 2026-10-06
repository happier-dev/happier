import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue } from '@happier-dev/protocol';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs';

import { useInputFieldOptions, type InputFieldOptionsRequest } from '@/components/sessions/actions/useInputFieldOptions';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WidgetPreviewWell, WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';

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

/**
 * The one Set up / Edit inputs step (lab `dashboards` dadd A/Ab, dbind E/X), inputs first: on desktop
 * the inputs column leads and the live preview sits beside it; on phones the inputs come first and a
 * compact preview follows. One button says where it goes ("Add to Home") or "Save"; while something
 * is still needed it stays off and the line beside it says what is left.
 *
 * The step owns only the draft. Admission is the binder's (`setup.resolve`, run on every change) and
 * the write is the canonical Action behind `setup.submit`; cancelling or going back writes nothing.
 * The preview mounts only while the step is open and the draft resolves.
 */
export function WidgetSetupStep(props: Readonly<{
    setup: WidgetSetup;
    phone: boolean;
    /** Back to the gallery (the add flow); absent for Edit inputs and in-card repair. */
    onBack?: () => void;
    onCancel: () => void;
    /** Edit inputs on a phone: the header caret closes the sheet (lab Ep), as Cancel does on desktop. */
    onClose?: () => void;
    /** After the Action acknowledged the write or retained it for approval. */
    onDone: (result: Extract<WidgetSetupSubmitResult, { ok: true }>) => void;
    /** Exact Home/session identity for option reads (never ambient). */
    serverId?: string | null;
    sessionId?: string | null;
    /** Opened by a repair: that input's choices start open. */
    focusPath?: string;
    testID: string;
}>): React.ReactElement {
    const { setup } = props;
    const [draft, setDraft] = React.useState<WidgetSetupDraft>(setup.initial);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const resolution = React.useMemo(() => setup.resolve(draft), [draft, setup]);
    const blocker = describeWidgetSetupBlocker(setup.fields, resolution);
    // Finishable once nothing blocks; a per-viewer input is each viewer's own and never blocks.
    const finishable = widgetSetupBlockingIssues(setup.fields, resolution).length === 0;

    // Choices come from the one options resolver, read only while this step is open.
    const discoveryContext = React.useMemo(() => setup.optionsContext?.(draft), [draft, setup]);
    const consumer = discoveryContext?.consumer;
    const selectedSession = consumer?.kind === 'widget' ? consumer.selectedSession : undefined;
    const optionServerId = selectedSession?.serverId ?? props.serverId;
    const requests = React.useMemo<InputFieldOptionsRequest[]>(() => setup.fields.map(({ field, viewer }) => ({
        ...discoveryContext,
        // Viewer discovery belongs to Connect. Literals without a declared source use the
        // public parser/picker, not an unused choices read merely because they name a type.
        field: viewer || (isLiteralWidgetSetupField(field) && field.optionsSourceId === undefined && field.connectedAccountOptions !== true)
            ? { path: field.path, ...(field.options ? { options: field.options } : {}) } : field,
    })), [discoveryContext, setup.fields]);
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
        } catch {
            setError(t('widgetAdd.saveFailed'));
        } finally {
            setBusy(false);
        }
    }, [busy, draft, finishable, props, setup]);

    // The fields' own predicates over the current draft (shown, required, disabled), from the one
    // neutral field owner: a hidden input leaves the step and a disabled one cannot be changed.
    const draftInput = discoveryContext?.draftInput;
    const effective = React.useMemo(() => new Map(resolveEffectiveInputFields(
        { inputHints: { fields: setup.fields.map(({ field }) => field) } }, draftInput ?? {}, { includeHidden: true },
    ).map((field) => [field.path, field])), [draftInput, setup.fields]);

    const inputs = (
        <InputTypePickerHostProvider enabled={setup.fields.some(({ field }) => field.inputType !== undefined)}
            {...options.resolveOptions.pickerContext}
            contextKey={JSON.stringify([consumer, draft, options.snapshot])}>
        <ListPresentationProvider value="page">
            <ItemGroup surface="none" density="compact">
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
    // drawing someone else's data. It is the real card at its own size (lab Ap): its first rows show
    // and the well's room clips the rest.
    const live = resolution.status === 'ready' && setup.renderPreview ? setup.renderPreview({ input: resolution.input, draft }) : null;
    const preview = setup.renderPreview ? (
        <WidgetPreviewWell
            testID={`${props.testID}.preview`}
            caption={live ? t('widgetAdd.previewLive') : t('widgetAdd.preview')}
            {...(props.phone ? { height: PHONE_PREVIEW_HEIGHT_PX } : { minHeight: PREVIEW_MIN_HEIGHT_PX })}
        >
            <WidgetFrame
                testID={`${props.testID}.previewCard`}
                frameStyle="card"
                placement="companion"
                mark={setup.widget?.mark ?? 'squares-four'}
                title={setup.widget?.title ?? setup.title}
                body={live ? { kind: 'content', children: live } : {
                    kind: 'content',
                    children: (
                        <Text style={styles.waiting} testID={`${props.testID}.previewWaiting`}>
                            {finishable ? t('widgetAdd.previewAfterAdd') : t('widgetAdd.previewWaiting', { field: blocker?.title ?? setup.fields[0]?.field.title ?? '' })}
                        </Text>
                    ),
                }}
            />
        </WidgetPreviewWell>
    ) : null;

    return (
        <WidgetFlowPanel
            testID={props.testID}
            phone={props.phone}
            title={setup.title}
            hint={setup.hint ?? null}
            {...(props.onBack ? { onBack: props.onBack } : {})}
            {...(props.onClose ? { onClose: props.onClose } : {})}
            noteTestID={`${props.testID}.why`}
            error={error}
            note={blocker ? t('widgetAdd.stillNeeded', { field: blocker.title }) : null}
            onCancel={props.onCancel}
            primary={{
                testID: `${props.testID}.submit`,
                label: setup.submitLabel,
                onPress: () => { void submit(); },
                disabled: !finishable,
                busy,
            }}
        >
            {props.phone ? (
                <View style={styles.bodyPhone}>
                    {inputs}
                    {preview}
                </View>
            ) : preview ? (
                <View style={styles.body}>
                    <View style={styles.inputs}>{inputs}</View>
                    <View style={styles.previewColumn}>{preview}</View>
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
    // The card's reserved rows while its inputs are still being chosen: what it waits for, quiet.
    waiting: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
        paddingBottom: 4,
    },
}));
