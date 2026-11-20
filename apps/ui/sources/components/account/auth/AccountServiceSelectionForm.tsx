import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AccountServiceEndpointV1 } from '@/sync/domains/server/serverProfiles';
import { OrganizationPolicyFieldNotice, OrganizationPolicyInvalidNextStep, readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import type { TextInput } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepFieldGroup, StepForm } from '@/components/onboarding/unauthShell/StepFormParts';
import { StepPrimaryButton, useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import { StepActions } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { t } from '@/text';
import type { SelectAccountServiceEndpointResult } from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { readAccountServiceDisplayName } from './accountServiceDisplayName';
import { useAccountServiceSelection } from './useAccountServiceSelection';

export type AccountServiceSelectionResult = SelectAccountServiceEndpointResult;

export type AccountServiceSelectionFormProps = Readonly<{
    currentEndpoint: AccountServiceEndpointV1 | null;
    onBack: () => void;
    onSelect: (url: string, options: Readonly<{ signal: AbortSignal }>) => Promise<AccountServiceSelectionResult>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    // The choices, the address and the step's actions stand a section apart (the step frame's rhythm).
    root: { width: '100%', gap: theme.space.s24 },
    choices: { gap: theme.space.s10 },
}));

/** A choice row: the service's name, else the address that tells it apart (shown beneath too). */
function endpointLabel(endpoint: AccountServiceEndpointV1): string {
    return readAccountServiceDisplayName({
        url: endpoint.url,
        serverIdentityId: endpoint.serverIdentityId,
        savedName: endpoint.displayName,
    }) ?? formatAccountServiceHost(endpoint.url);
}

export const AccountServiceSelectionForm = React.memo(function AccountServiceSelectionForm(props: AccountServiceSelectionFormProps) {
    useUnistyles();
    const styles = stylesheet;
    const policy = readOrganizationPolicyFieldState('accountService');
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const currentEndpoint = props.currentEndpoint?.url ? props.currentEndpoint : null;
    const [showUrlInput, setShowUrlInput] = React.useState(currentEndpoint == null);
    const [url, setUrl] = React.useState('');
    const selection = useAccountServiceSelection(props.onSelect);
    const error = selection.error;

    const select = React.useCallback(async (rawUrl: string) => {
        const result = await selection.submit(rawUrl);
        if (result?.kind === 'selected') return;
        if (result || !rawUrl.trim()) {
            setShowUrlInput(true);
            inputRef.current?.focus();
        }
    }, [selection.submit]);

    const goBack = React.useCallback(() => {
        selection.cancel();
        props.onBack();
    }, [props.onBack, selection.cancel]);
    // The shell's Back (the row's on a computer, the corner's on a phone) abandons a check still in flight first.
    useStepBackOverride(goBack);

    return (
        <View testID="account-service-selection-form" style={styles.root}>
            {/* Option F cards when there is a current service to keep (it signs in at once); with none, the address is
                the step's only question and stands alone (lab "Your sign-in service"). */}
            {currentEndpoint || policy.lock || policy.disabled ? (
                <View style={styles.choices}>
                    <SelectionTiles
                        variant="card"
                        accessibilityLabel={t('homeAdd.signInServiceAddress')}
                        options={[
                            ...(currentEndpoint ? [{
                                id: 'current' as const,
                                testID: 'account-service-current-choice',
                                disabled: policy.disabled && !policy.lock,
                                icon: 'globe' as const,
                                title: endpointLabel(currentEndpoint),
                                subtitle: currentEndpoint.url,
                            }] : []),
                            {
                                id: 'another' as const,
                                testID: 'account-service-another-choice',
                                disabled: policy.disabled,
                                icon: 'plus-circle' as const,
                                title: t('homeAdd.otherSignInService'),
                                subtitle: policy.lock ? t('organizationPolicy.lockedExplanation') : t('homeAdd.otherSignInServiceSubtitle'),
                            },
                        ]}
                        value={showUrlInput ? 'another' : null}
                        onChange={(id) => {
                            if (id === 'current' && currentEndpoint) void select(currentEndpoint.url);
                            if (id === 'another') setShowUrlInput(true);
                        }}
                        maximumColumns={1}
                    />
                    <OrganizationPolicyFieldNotice field="accountService" />
                    <OrganizationPolicyInvalidNextStep />
                </View>
            ) : null}
            {showUrlInput && !policy.lock ? (
                <StepForm>
                    <StepFieldGroup>
                        <FieldTextInput
                            ref={inputRef}
                            testID="account-service-url-input"
                            accessibilityLabel={t('homeAdd.signInServiceAddress')}
                            editable={!policy.disabled}
                            accessibilityHint={policy.accessibilityHint}
                            placeholder={t('common.urlPlaceholder')}
                            value={url}
                            onChangeText={(value) => {
                                setUrl(value);
                                if (error) selection.clearError();
                            }}
                            onSubmitEditing={policy.disabled ? undefined : () => {
                                void select(url);
                            }}
                            invalid={error !== null}
                            autoFocus={!policy.disabled && props.currentEndpoint == null}
                            autoCapitalize="none"
                            keyboardType="url"
                            returnKeyType="go"
                        />
                    </StepFieldGroup>
                    {/* What the check found, as the step's notice line (lab: "Can't reach your sign-in service"). */}
                    {error ? (
                        <SurfaceStateCard testID="account-service-url-error" size="line" lineLayout="notice" kind="error"
                            title={error} accessibilitySemantics="alert" />
                    ) : null}
                </StepForm>
            ) : null}
            <StepActions onBack={goBack}>
                {showUrlInput && !policy.lock ? (
                    <StepPrimaryButton testID="account-service-url-submit" title={t('common.continue')} disabled={policy.disabled}
                        onPress={() => select(url)} />
                ) : null}
            </StepActions>
        </View>
    );
});
