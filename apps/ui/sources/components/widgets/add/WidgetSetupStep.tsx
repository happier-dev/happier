import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue } from '@happier-dev/protocol';

import { useInputFieldOptions, type InputFieldOptionsRequest } from '@/components/sessions/actions/useInputFieldOptions';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WidgetSetupFieldRow, type WidgetSetupFieldChange } from './WidgetSetupFieldRow';
import {
    describeWidgetSetupBlocker,
    describeWidgetSetupRow,
    setWidgetSetupBinding,
    widgetSetupBlockingIssues,
    type WidgetSetup,
    type WidgetSetupDraft,
    type WidgetSetupValue,
    type WidgetSetupSubmitResult,
} from './widgetSetupModel';

/** The preview box keeps one height while inputs change, so the step never jumps under the pointer. */
const PREVIEW_MIN_HEIGHT_PX = 168;
const PHONE_PREVIEW_HEIGHT_PX = 148;
/** The phone's preview is the real widget a step smaller, so its first rows read below the inputs. */
const PHONE_PREVIEW_SCALE = 0.86;

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
    /** After the Action acknowledged the write or retained it for approval. */
    onDone: (result: Extract<WidgetSetupSubmitResult, { ok: true }>) => void;
    /** Exact Home/session identity for option reads (never ambient). */
    serverId?: string | null;
    sessionId?: string | null;
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
    const finishable = widgetSetupBlockingIssues(setup.fields, resolution).length === 0;

    // Choices come from the one options resolver, read only while this step is open.
    const consumer = setup.optionsConsumer;
    const requests = React.useMemo<InputFieldOptionsRequest[]>(() => setup.fields.map(({ field }) => ({
        ...(consumer ? { consumer } : {}),
        field: {
            path: field.path,
            ...(field.inputType ? { inputType: field.inputType } : {}),
            ...(field.options ? { options: field.options } : {}),
            ...(field.optionsSourceId
                ? { optionsSourceId: field.optionsSourceId }
                : {}),
        },
    })), [consumer, setup.fields]);
    const options = useInputFieldOptions({
        requests,
        enabled: true,
        ...(props.serverId ? { serverId: props.serverId } : {}),
        ...(props.sessionId ? { sessionId: props.sessionId } : {}),
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

    const inputs = (
        <InputTypePickerHostProvider enabled={setup.fields.some(({ field }) => field.inputType !== undefined)}
            {...options.resolveOptions.pickerContext}
            contextKey={JSON.stringify([consumer, draft, options.snapshot])}>
        <ListPresentationProvider value="page">
            <ItemGroup surface="none" density="compact">
                {setup.fields.map((entry, index) => {
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
                    return (
                        <WidgetSetupFieldRow
                            key={entry.field.path}
                            testID={`${props.testID}.field.${entry.field.path}`}
                            entry={entry}
                            row={row}
                            options={values}
                            optionsStatus={state.status}
                            plainValue={binding?.kind === 'value' ? binding.value : undefined}
                            phone={props.phone}
                            disabled={busy}
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
    // only resolves for each viewer once added; the box then says it will show once added rather
    // than drawing someone else's data.
    const live = resolution.status === 'ready' && setup.renderPreview ? setup.renderPreview({ input: resolution.input, draft }) : null;
    const preview = setup.renderPreview ? (
        <View style={[styles.preview, props.phone ? styles.previewPhone : null]} testID={`${props.testID}.preview`}>
            <Text style={styles.previewCaption}>{live ? t('widgetAdd.previewLive') : t('widgetAdd.preview')}</Text>
            {live ? (
                <View style={props.phone ? styles.previewScaled : styles.previewBody} pointerEvents="none">
                    {live}
                </View>
            ) : (
                <View style={styles.previewWaiting} testID={`${props.testID}.previewWaiting`}>
                    <Icon name="squares-four" size={16} color={theme.colors.text.tertiary} />
                    <Text style={styles.previewWaitingText}>{finishable ? t('widgetAdd.previewAfterAdd') : t('widgetAdd.previewWaiting')}</Text>
                </View>
            )}
        </View>
    ) : null;

    const why = error ?? (blocker ? t('widgetAdd.stillNeeded', { field: blocker.title }) : null);
    return (
        <View testID={props.testID} accessibilityLabel={setup.title} style={styles.root}>
            <View style={styles.header}>
                {props.onBack ? (
                    <HappierPressable
                        testID={`${props.testID}.back`}
                        accessibilityRole="button"
                        accessibilityLabel={t('widgetAdd.backToGallery')}
                        onPress={props.onBack}
                        style={(state) => [styles.back, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Icon name="caret-left" size={16} color={theme.colors.text.secondary} />
                    </HappierPressable>
                ) : null}
                <View style={styles.titleBlock}>
                    <Text style={[styles.title, props.phone ? styles.titlePhone : null]} accessibilityRole="header" numberOfLines={1}>
                        {setup.title}
                    </Text>
                    {setup.hint ? <Text style={styles.hint} numberOfLines={2}>{setup.hint}</Text> : null}
                </View>
            </View>
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
            <View style={[styles.footer, props.phone ? styles.footerPhone : null]}>
                {props.phone ? null : (
                    <Text
                        style={[styles.why, error ? styles.whyError : null]}
                        numberOfLines={2}
                        testID={`${props.testID}.why`}
                        accessibilityLiveRegion="polite"
                    >
                        {why ?? ''}
                    </Text>
                )}
                {props.phone ? null : (
                    <RoundButton
                        testID={`${props.testID}.cancel`}
                        size="small"
                        display="secondary"
                        title={t('common.cancel')}
                        onPress={props.onCancel}
                    />
                )}
                <View style={props.phone ? styles.submitPhone : null}>
                    <RoundButton
                        testID={`${props.testID}.submit`}
                        size={props.phone ? 'normal' : 'small'}
                        title={setup.submitLabel}
                        disabled={!finishable || busy}
                        loading={busy}
                        {...(why ? { accessibilityHint: why } : {})}
                        onPress={() => { void submit(); }}
                    />
                </View>
            </View>
            {props.phone && error ? <Text style={[styles.why, styles.whyError, styles.whyPhone]}>{error}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 8 },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 8 },
    back: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginTop: -2 },
    titleBlock: { flex: 1, minWidth: 0, gap: 1, paddingTop: 1 },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary },
    titlePhone: { ...happierPageTextMetrics('rowTitle'), fontSize: 17, lineHeight: 22 },
    hint: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.text.tertiary },
    body: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
    bodyPhone: { gap: 6 },
    inputs: { flexGrow: 1.25, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    previewColumn: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, paddingTop: 2 },
    preview: {
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingTop: 8,
        paddingBottom: 10,
        minHeight: PREVIEW_MIN_HEIGHT_PX,
        gap: 6,
    },
    previewPhone: { minHeight: 0, height: PHONE_PREVIEW_HEIGHT_PX, overflow: 'hidden', marginHorizontal: 4 },
    previewCaption: { ...Typography.default('semiBold'), fontSize: 11.5, lineHeight: 15, color: theme.colors.text.tertiary, paddingHorizontal: 2 },
    previewBody: { flexShrink: 1 },
    previewScaled: {
        width: `${100 / PHONE_PREVIEW_SCALE}%` as const,
        transform: [{ scale: PHONE_PREVIEW_SCALE }],
        transformOrigin: 'top left',
    },
    previewWaiting: {
        flex: 1,
        minHeight: 96,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 9,
        borderWidth: StyleSheet.hairlineWidth,
        borderStyle: 'dashed',
        borderColor: theme.colors.border.default,
    },
    previewWaitingText: { ...Typography.default(), fontSize: 12.5, lineHeight: 17, color: theme.colors.text.tertiary },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
        paddingTop: 10,
        paddingHorizontal: 4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footerPhone: { paddingTop: 12 },
    submitPhone: { flex: 1 },
    why: { ...Typography.default(), flex: 1, fontSize: 12, lineHeight: 16, color: theme.colors.text.tertiary },
    whyError: { color: theme.colors.state.danger.foreground },
    whyPhone: { paddingHorizontal: 4, paddingTop: 6, textAlign: 'center' },
}));
