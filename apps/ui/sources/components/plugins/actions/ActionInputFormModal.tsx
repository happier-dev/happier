import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import {
    HappierValidationMessage,
    resolveHappierFormPending,
} from '@happier-dev/plugin-ui/presentation';

import type { CustomModalInjectedProps } from '@/modal';
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
    const router = useRouter();
    const pluginUiTheme = usePluginUiTheme(theme);
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    const onRetireRef = React.useRef(props.onRetire);
    onRetireRef.current = props.onRetire;
    const [error, setError] = React.useState<string | null>(null);

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
                setError(t('pluginRuntime.unavailableGeneric'));
            } catch {
                setError(t('pluginRuntime.unavailableGeneric'));
            }
        })();
    }, [props.form, props.onClose]);

    const repairConnectedAccounts = React.useCallback(() => {
        // A fresh open after repair must re-resolve the one host-owned source;
        // retaining this transient form would leave its resolved-empty snapshot
        // falsely current behind the Settings route.
        close();
        router.push('/(app)/settings/connected-services');
    }, [close, router]);

    const footer = React.useMemo(() => (
        <ModalCardFooterActions cancel={{ onPress: close, testID: 'plugin-contributed-action-form-cancel' }}>
            {hasResolvedEmptyConnectedAccountOptions ? (
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
    ), [close, hasResolvedEmptyConnectedAccountOptions, pending, props.form.presentation.inputHints.submitLabel, props.form.presentation.title, repairConnectedAccounts, submit]);

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
                        message={error}
                        theme={pluginUiTheme}
                        accessibilityLiveRegion="polite"
                    />
                </View>
            ) : null}
        </ScrollView>
    );
}
