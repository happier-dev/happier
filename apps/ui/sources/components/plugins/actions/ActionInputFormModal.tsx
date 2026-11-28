import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierValidationMessage,
    resolveHappierFormPending,
} from '@happier-dev/plugin-ui/presentation';

import { readInputPath } from '@happier-dev/protocol/inputs';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { CustomModalInjectedProps } from '@/modal';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { useActionFieldCreation } from '@/components/sessions/actions/useActionFieldCreation';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { InputTypePickerHostContext } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { isDeferredApprovalResult, normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { publishPresentationNotice, readPresentationNotice } from '@/components/sessions/presentation/presentationNotices';

import type {
    ActionInputForm,
    ActionInputFormSubmitOutcome,
    ActionInputFormSubmissionResult,
} from './actionInputForm';

type AnyActionInputForm = ActionInputForm<
    ActionInputFormSubmissionResult,
    string,
    string
>;

const stylesheet = StyleSheet.create((theme) => ({
    // The card's band and footer own their inset; the fields stand on the same edge.
    content: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s8,
    },
    error: {
        marginTop: theme.space.s12,
    },
    notice: {
        marginBottom: theme.space.s12,
    },
}));

function isSuccessfulSubmit(
    outcome: ActionInputFormSubmitOutcome<
        ActionInputFormSubmissionResult,
        string,
        string
    >,
): boolean {
    return outcome.kind === 'settled' && outcome.outcome.ok;
}

/**
 * A settled Action is confirmed once, where the person acted, through the shared notice host; its result is
 * never drawn. A form that only selected a value carries no result, and an Action waiting for approval is not done.
 * The caller skips this when the Action's own path already published a notice (an Undo, a skipped automation).
 */
function confirmSettledAction(settled: ActionInputFormSubmissionResult, title: string, actionId: string | undefined): void {
    if (!('result' in settled) || isDeferredApprovalResult({ ok: true, result: settled.result })) return;
    publishPresentationNotice({
        key: `action-form-settled:${actionId ?? title}`,
        severity: 'info',
        message: t('pluginRuntime.actionDone', { action: title }),
        emphasis: title,
    });
}

/** A required field the person left empty: its owner would refuse the input, so the form says so first. */
function isMissingRequiredValue(
    field: Readonly<{ path: string; required?: boolean }>,
    input: Readonly<Record<string, unknown>>,
): boolean {
    if (field.required !== true) return false;
    const value = readInputPath(input, field.path);
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export type ReadSubmittedActionOption = (fieldPath: string) => Readonly<{ value: string; label: string }> | undefined;

export type ValidateActionInput = (
    input: Readonly<Record<string, unknown>>,
) => Readonly<{ message?: string; /** The field the message is about; it is said under that field. */ path?: string }> | undefined;

export type ActionInputFormModalProps = Readonly<{
    onSubmitOptions?: (readOption: ReadSubmittedActionOption) => void;
    form: AnyActionInputForm;
    validateInput?: ValidateActionInput;
    pickerContext?: InputTypePickerHostContext;
    actionId?: string;
    anchor?: PopoverAnchor;
    /** Releases the host's modal/currentness binding; idempotent by contract. */
    onRetire?: () => void;
    /** The host's own name for this form (Deploy on push or merge); its primary then continues the host's flow. */
    heading?: ActionInputFormHeading;
}> & CustomModalInjectedProps;

export type ActionInputFormHeading = Readonly<{ title: string; description?: string }>;

/** The target-neutral RN/RNW host renderer for a normalized SDK Action form. */
export function ActionInputFormModal(props: ActionInputFormModalProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pluginUiTheme = usePluginUiTheme(theme);
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    const onRetireRef = React.useRef(props.onRetire);
    onRetireRef.current = props.onRetire;
    const [error, setError] = React.useState<ReturnType<typeof presentActionExecutionFailure> | null>(null);
    // Set by a press while a shown required field is empty; each such field then says so until it is filled.
    const [requiredAsked, setRequiredAsked] = React.useState(false);

    React.useEffect(() => {
        const unsubscribe = props.form.subscribe(() => refresh());
        return () => {
            unsubscribe();
            props.form.retire();
            onRetireRef.current?.();
        };
    }, [props.form]);

    const input = props.form.getInput();
    const fields = props.form.getFields();
    const validation = props.validateInput?.(input);
    const fieldOptions = useInputFieldOptions({
        ...props.pickerContext,
        requests: fields.map((field) => ({ field, actionId: props.actionId, draftInput: input })),
        enabled: fields.some((field) => field.inputType !== undefined || field.optionsSourceId !== undefined),
    });
    const isSubmitting = props.form.isSubmitting();
    const pending = resolveHappierFormPending({ busy: isSubmitting });
    const title = props.heading?.title ?? props.form.presentation.inputHints.title ?? props.form.presentation.title;
    const description = props.heading ? props.heading.description
        : props.form.presentation.inputHints.description ?? props.form.presentation.description;
    // A required account choice with no account cannot succeed: the form leads to connecting one instead of submitting.
    const missingAccountField = fields.find((field) => field.resolvedEmptyConnectedAccountOptions === true && field.required === true);
    const shownFields = React.useMemo(() => missingAccountField
        ? fields.filter(field => field !== missingAccountField) : fields, [fields, missingAccountField]);
    // A message about one shown field stands under it; any other stands at the form's foot.
    const fieldIssuePath = validation?.message && shownFields.some(field => field.path === validation.path)
        ? validation.path : undefined;
    const submitLabel = props.form.presentation.inputHints.submitLabel
        ?? (props.heading ? t('common.continue') : props.form.presentation.title);
    // A Connected Account choice always offers adding one: the right account may not exist yet.
    const offersConnectedAccounts = props.form.presentation.choosesConnectedAccount === true
        || fields.some((field) => field.resolvedEmptyConnectedAccountOptions === true);

    const pickerFields = {
        fields: shownFields,
        input: { ...input },
        editable: !pending,
        busy: pending,
        resolveFieldOptions: fieldOptions.resolveOptions,
        resolveFieldIssue: (field: (typeof fields)[number]) => field.path === fieldIssuePath ? validation?.message
            : requiredAsked && isMissingRequiredValue(field, input) ? t('pluginRuntime.requiredFieldMissing') : undefined,
        onPatch: (patch: Record<string, unknown>) => {
            setError(null);
            props.form.replaceInput({ ...props.form.getInput(), ...patch });
        },
    };

    const close = React.useCallback(() => {
        props.form.cancel();
        onRetireRef.current?.();
        props.onClose();
    }, [props.form, props.onClose]);

    const submit = React.useCallback(() => {
        if (props.form.isSubmitting() || props.validateInput?.(props.form.getInput())) return;
        const current = props.form.getInput();
        if (shownFields.some(field => isMissingRequiredValue(field, current))) {
            setRequiredAsked(true);
            return;
        }
        props.onSubmitOptions?.(path => {
            const field = fields.find(candidate => candidate.path === path);
            const value = readInputPath(props.form.getInput(), path);
            if (!field || typeof value !== 'string') return undefined;
            const option = fieldOptions.resolveOptions(field).find(choice => choice.value === value);
            return option ? { value, label: option.label } : undefined;
        });
        setError(null);
        void (async () => {
            try {
                const noticeBefore = readPresentationNotice();
                const outcome = await props.form.submit();
                if (isSuccessfulSubmit(outcome)) {
                    if (outcome.kind === 'settled' && readPresentationNotice() === noticeBefore) {
                        confirmSettledAction(outcome.outcome, props.form.presentation.title, props.actionId);
                    }
                    props.onClose();
                    return;
                }
                if (outcome.kind === 'stale') {
                    props.onClose();
                    return;
                }
                if (outcome.kind === 'unavailable' && outcome.reason === 'submission_in_flight') {
                    return;
                }
                if (outcome.kind === 'settled' && outcome.outcome.cancelled) {
                    return;
                }
                const code = outcome.kind === 'settled' ? outcome.outcome.code : outcome.reason;
                const message = code ? resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code,
                    executionTarget: props.form.presentation.executionTarget }).body
                    : t('pluginRuntime.unavailableGeneric');
                const presentation = presentActionExecutionFailure({
                    ...(outcome.kind === 'settled' ? outcome.outcome : { ok: false }),
                    errorCode: code ?? 'action_failed',
                }, message);
                setError({ ...presentation, technicalDetails: [...presentation.technicalDetails,
                    ...(outcome.kind === 'settled' && outcome.outcome.phase ? [{ key: 'phase',
                        label: t('approvals.failureTechnicalLabels.causePhase'), value: outcome.outcome.phase }] : []),
                ] });
            } catch (error) {
                setError(presentActionExecutionFailure({ ok: false, ...normalizeActionExecutorThrownError(error) }, t('pluginRuntime.unavailableGeneric')));
            }
        })();
    }, [fieldOptions.resolveOptions, fields, props.actionId, props.form, props.onClose, props.onSubmitOptions, props.validateInput, shownFields]);

    const repairConnectedAccounts = React.useCallback(() => {
        // A fresh open after repair re-resolves the form's options on its admitted target.
        close();
        void presentConnectSheet({
            intent: 'link',
            ...(props.pickerContext?.machineId && props.pickerContext.serverId ? {
                initialMachineTarget: {
                    serverIdentityId: captureServerProfileScopeResolver()(props.pickerContext.serverId),
                    machineId: props.pickerContext.machineId,
                },
            } : {}),
        });
    }, [close, props.pickerContext?.machineId, props.pickerContext?.serverId]);

    const footer = React.useMemo(() => (
        <ModalCardFooterActions cancel={{ onPress: close, testID: 'plugin-contributed-action-form-cancel' }}>
            {missingAccountField ? (
                <RoundButton
                    testID="plugin-contributed-action-form-repair-connected-accounts"
                    accessibilityLabel={t('connectedServicesSetup.connectAccount', { account: missingAccountField.title })}
                    title={t('connectedServicesSetup.connectAccount', { account: missingAccountField.title })}
                    onPress={repairConnectedAccounts}
                />
            ) : null}
            {!missingAccountField && offersConnectedAccounts ? (
                <RoundButton
                    testID="plugin-contributed-action-form-repair-connected-accounts"
                    accessibilityLabel={t('connectedServices.title')}
                    title={t('connectedServices.title')}
                    display="secondary"
                    onPress={repairConnectedAccounts}
                />
            ) : null}
            {missingAccountField ? null : (
                <RoundButton
                    testID="plugin-contributed-action-form-submit"
                    accessibilityLabel={submitLabel}
                    title={submitLabel}
                    disabled={pending || validation !== undefined}
                    loading={pending}
                    onPress={submit}
                />
            )}
        </ModalCardFooterActions>
    ), [close, missingAccountField, offersConnectedAccounts, pending, repairConnectedAccounts, submit, submitLabel, validation]);

    const chrome = React.useMemo(() => ({
        ...createAnchoredSheetChrome({ title, subtitle: description ?? undefined, anchor: props.anchor }),
        footer,
    }), [description, footer, props.anchor, title]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {missingAccountField ? (
                <View style={styles.notice}>
                    <HappierValidationMessage
                        testID="plugin-contributed-action-form-connected-accounts-empty"
                        message={t('connectedServicesSetup.accountNeededFirst', { account: missingAccountField.title })}
                        theme={pluginUiTheme}
                        accessibilityLiveRegion="polite"
                    />
                </View>
            ) : null}
            {props.pickerContext?.accountLifetime && (props.pickerContext.fieldCreationProjection ?? props.pickerContext.pluginUiProjection)
                && shownFields.some(field => field.createNew)
                ? <ActionFormFieldsWithCreation {...pickerFields} pickerContext={props.pickerContext}
                    lifetime={props.pickerContext.accountLifetime} />
                : <ActionInputFields {...pickerFields} />}
            {validation?.message && fieldIssuePath === undefined ? (
                <View style={styles.error}>
                    <HappierValidationMessage
                        message={validation.message}
                        theme={pluginUiTheme}
                        accessibilityLiveRegion="polite"
                    />
                </View>
            ) : null}
            {error ? (
                <View style={styles.error}>
                    <HappierValidationMessage
                        testID="plugin-contributed-action-form-error"
                        message={error.reason}
                        theme={pluginUiTheme}
                        accessibilityLiveRegion="polite"
                    />
                    <TechnicalDetailsDisclosure
                        testID="plugin-contributed-action-form-error-details"
                        title={t('approvals.technicalDetails')}
                        lines={error.technicalDetails}
                    />
                </View>
            ) : null}
        </ScrollView>
    );
}

function ActionFormFieldsWithCreation(props: React.ComponentProps<typeof ActionInputFields> & Readonly<{
    pickerContext: InputTypePickerHostContext;
    lifetime: ServerAccountScopeLifetime;
}>) {
    const rawCredential = props.input.credentialRef;
    const credential = React.useMemo(() => QualifiedConnectedAccountRefSchema.safeParse(rawCredential), [rawCredential]);
    const creation = useActionFieldCreation({
        pickerContext: props.pickerContext,
        lifetime: props.lifetime,
        enabled: props.editable,
        account: credential.success ? credential.data : null,
        fields: props.fields,
        values: props.input,
        onCreated: props.onPatch,
    });
    const resolveOptions = creation.withCreatedChoices(props.resolveFieldOptions);
    return <ActionInputFields {...props} resolveFieldOptions={resolveOptions}
        resolveChoiceAction={field => creation.choiceAction(field, resolveOptions)} />;
}
