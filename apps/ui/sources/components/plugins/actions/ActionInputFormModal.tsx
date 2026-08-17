import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import type { ActionInputFieldHint } from '@happier-dev/protocol';
import {
    HappierValidationMessage,
    resolveHappierFormPending,
} from '@happier-dev/plugin-ui/presentation';

import type { CustomModalInjectedProps } from '@/modal';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { ActionInputFields, type ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

import type {
    ActionInputForm,
    ActionInputFormSubmitOutcome,
    ActionInputFormSubmissionResult,
} from './actionInputForm';

type AnyActionInputForm = ActionInputForm<ActionInputFormSubmissionResult, string, string>;

const stylesheet = StyleSheet.create(() => ({
    content: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    error: {
        marginTop: 12,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
}));

function staticFieldOptions(field: Pick<ActionInputFieldHint, 'options'>): readonly ActionFieldOption[] {
    return field.options ?? [];
}

function isSuccessfulSubmit(
    outcome: ActionInputFormSubmitOutcome<ActionInputFormSubmissionResult, string, string>,
): boolean {
    return outcome.kind === 'settled' && outcome.outcome.ok;
}

export type ActionInputFormModalProps = Readonly<{
    form: AnyActionInputForm;
    /** Releases the host's modal/currentness binding; idempotent by contract. */
    onRetire?: () => void;
}> & CustomModalInjectedProps;

/** The target-neutral RN/RNW host renderer for a normalized SDK Action form. */
export function ActionInputFormModal(props: ActionInputFormModalProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const pluginUiTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
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
        <View style={styles.footer}>
            <RoundButton
                testID="plugin-contributed-action-form-cancel"
                accessibilityLabel={t('common.cancel')}
                title={t('common.cancel')}
                size="normal"
                display="inverted"
                onPress={close}
            />
            {hasResolvedEmptyConnectedAccountOptions ? (
                <RoundButton
                    testID="plugin-contributed-action-form-repair-connected-accounts"
                    accessibilityLabel={t('connectedServices.title')}
                    title={t('connectedServices.title')}
                    size="normal"
                    display="inverted"
                    onPress={repairConnectedAccounts}
                />
            ) : null}
            <RoundButton
                testID="plugin-contributed-action-form-submit"
                accessibilityLabel={props.form.presentation.inputHints.submitLabel ?? props.form.presentation.title}
                title={props.form.presentation.inputHints.submitLabel ?? props.form.presentation.title}
                size="normal"
                disabled={pending}
                loading={pending}
                onPress={submit}
            />
        </View>
    ), [close, hasResolvedEmptyConnectedAccountOptions, pending, props.form.presentation.inputHints.submitLabel, props.form.presentation.title, repairConnectedAccounts, styles.footer, submit]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        ...(description ? { subtitle: description } : {}),
        footer,
        dimensions: { size: 'md' as const, maxHeightRatio: 0.84 },
        scrollHost: 'body' as const,
    }), [description, footer, title]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <ActionInputFields
                fields={fields}
                input={{ ...input }}
                editable={!pending}
                busy={pending}
                resolveFieldOptions={staticFieldOptions}
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
