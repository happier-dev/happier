import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierValidationMessage,
    resolveHappierFormPending,
} from '@happier-dev/plugin-ui/presentation';

import type { CustomModalInjectedProps } from '@/modal';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import type { InputTypePickerHostContext } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

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

export type ActionInputFormModalProps = Readonly<{
    form: AnyActionInputForm;
    pickerContext?: InputTypePickerHostContext;
    actionId?: string;
    anchor?: PopoverAnchor;
    /** Releases the host's modal/currentness binding; idempotent by contract. */
    onRetire?: () => void;
}> & CustomModalInjectedProps;

/** The target-neutral RN/RNW host renderer for a normalized SDK Action form. */
export function ActionInputFormModal(props: ActionInputFormModalProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pluginUiTheme = usePluginUiTheme(theme);
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    const onRetireRef = React.useRef(props.onRetire);
    onRetireRef.current = props.onRetire;
    const [error, setError] = React.useState<ReturnType<typeof presentActionExecutionFailure> | null>(null);

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
    const fieldOptions = useInputFieldOptions({
        ...props.pickerContext,
        requests: fields.map((field) => ({ field, actionId: props.actionId, draftInput: input })),
        enabled: fields.some((field) => field.inputType !== undefined || field.optionsSourceId !== undefined),
    });
    const isSubmitting = props.form.isSubmitting();
    const pending = resolveHappierFormPending({ busy: isSubmitting });
    const title = props.form.presentation.inputHints.title ?? props.form.presentation.title;
    const description = props.form.presentation.inputHints.description ?? props.form.presentation.description;
    const hasResolvedEmptyConnectedAccountOptions = fields.some((field) => (
        field.resolvedEmptyConnectedAccountOptions === true
    ));
    // A Connected Account choice always offers adding one: the right account may not exist yet.
    const offersConnectedAccounts = hasResolvedEmptyConnectedAccountOptions
        || props.form.presentation.choosesConnectedAccount === true;

    const close = React.useCallback(() => {
        props.form.cancel();
        onRetireRef.current?.();
        props.onClose();
    }, [props.form, props.onClose]);

    const submit = React.useCallback(() => {
        if (props.form.isSubmitting()) return;
        setError(null);
        void (async () => {
            try {
                const outcome = await props.form.submit();
                if (isSuccessfulSubmit(outcome)) {
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
                const message = code ? resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code }).body
                    : t('pluginRuntime.unavailableGeneric');
                const presentation = presentActionExecutionFailure({ ok: false, errorCode: code ?? 'action_failed' }, message);
                setError({ ...presentation, technicalDetails: [...presentation.technicalDetails,
                    ...(outcome.kind === 'settled' && outcome.outcome.phase ? [{ key: 'phase',
                        label: t('approvals.failureTechnicalLabels.causePhase'), value: outcome.outcome.phase }] : []),
                ] });
            } catch (error) {
                setError(presentActionExecutionFailure({ ok: false, ...normalizeActionExecutorThrownError(error) }, t('pluginRuntime.unavailableGeneric')));
            }
        })();
    }, [props.form, props.onClose]);

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
            {offersConnectedAccounts ? (
                <RoundButton
                    testID="plugin-contributed-action-form-repair-connected-accounts"
                    accessibilityLabel={t('connectedServices.title')}
                    title={t('connectedServices.title')}
                    display="secondary"
                    onPress={repairConnectedAccounts}
                />
            ) : null}
            <RoundButton
                testID="plugin-contributed-action-form-submit"
                accessibilityLabel={props.form.presentation.inputHints.submitLabel ?? props.form.presentation.title}
                title={props.form.presentation.inputHints.submitLabel ?? props.form.presentation.title}
                disabled={pending}
                loading={pending}
                onPress={submit}
            />
        </ModalCardFooterActions>
    ), [close, offersConnectedAccounts, pending, props.form.presentation.inputHints.submitLabel, props.form.presentation.title, repairConnectedAccounts, submit]);

    const chrome = React.useMemo(() => ({
        ...createAnchoredSheetChrome({ title, subtitle: description ?? undefined, anchor: props.anchor }),
        footer,
    }), [description, footer, props.anchor, title]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <ActionInputFields
                fields={fields}
                input={{ ...input }}
                editable={!pending}
                busy={pending}
                resolveFieldOptions={fieldOptions.resolveOptions}
                onPatch={(patch) => {
                    setError(null);
                    props.form.replaceInput({ ...props.form.getInput(), ...patch });
                }}
            />
            {hasResolvedEmptyConnectedAccountOptions ? (
                <View style={styles.error}>
                    <HappierValidationMessage
                        testID="plugin-contributed-action-form-connected-accounts-empty"
                        message={t('connectedServices.list.notConnected')}
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
