import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet as UnistylesStyleSheet } from 'react-native-unistyles';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { useLocalRelayAccessControl } from '@/components/settings/server/localControl/useLocalRelayAccessControl';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Text } from '@/components/ui/text/Text';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { RelayAccessControlOptions } from '@/components/settings/server/relayAccess/useRelayAccessControl';
import { RelayAccessCredentialFields } from '@/components/settings/server/relayAccess/RelayAccessCredentialFields';

import { RelayAccessWizardBusyOverlay } from './RelayAccessWizardBusyOverlay';
import type { RelayAccessConfigStepDefinition, RelayAccessConfigStepDraft, RelayAccessCredentialRefs } from './relayAccessConfigStepCatalog';
import {
    type RelayAccessWizardPrimaryState,
    useRelayAccessWizardConfigStep,
} from './useRelayAccessWizardConfigStep';

const stylesheet = UnistylesStyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: theme.space.s12,
    },
    form: {
        width: '100%',
        gap: theme.space.s10,
    },
    hint: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
}));

const EMPTY_CREDENTIAL_REFS: RelayAccessCredentialRefs = Object.freeze([]);

export type RelayAccessConfigFieldsStepProps = Readonly<{
    testID?: string;
    runner?: SystemTaskRunner;
    definition: RelayAccessConfigStepDefinition;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    runWithTarget?: RelayAccessControlOptions['runWithTarget'];
    remoteHost?: RelayAccessControlOptions['remoteHost'];
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: RelayAccessWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>;

export const RelayAccessConfigFieldsStep = React.memo(function RelayAccessConfigFieldsStep(
    props: RelayAccessConfigFieldsStepProps,
) {
    const styles = stylesheet;
    const [draft, setDraft] = React.useState<RelayAccessConfigStepDraft>(props.definition.readConfiguredDraft(null));
    const [credentialRefsDraft, setCredentialRefsDraft] = React.useState<RelayAccessCredentialRefs | null>(null);
    const {
        activeTaskSnapshot,
        actionScope,
        configure,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        snapshot,
    } = useLocalRelayAccessControl({
        runner: props.runner,
        upstreamUrl: props.upstreamUrl ?? null,
        target: props.target,
        runWithTarget: props.runWithTarget,
        remoteHost: props.remoteHost,
    });

    const configuredDraft = React.useMemo(
        () => props.definition.readConfiguredDraft(snapshot),
        [props.definition, snapshot],
    );
    const normalizedDraft = React.useMemo(
        () => props.definition.normalizeDraft(draft),
        [draft, props.definition],
    );
    const configuredCredentialRefs = snapshot?.providerId === props.definition.providerId
        ? snapshot.selection?.credentialRefs ?? EMPTY_CREDENTIAL_REFS
        : EMPTY_CREDENTIAL_REFS;
    const credentialRefs = credentialRefsDraft ?? configuredCredentialRefs;
    const needsSave = React.useMemo(
        () => props.definition.isSaveNeeded({ configuredDraft, normalizedDraft, configuredCredentialRefs, credentialRefs }),
        [configuredDraft, normalizedDraft, configuredCredentialRefs, credentialRefs, props.definition],
    );

    useRelayAccessWizardConfigStep({
        providerId: props.definition.providerId,
        upstreamUrl: props.upstreamUrl,
        serverProfileId: props.serverProfileId,
        onShareUrlChange: props.onShareUrlChange,
        onWizardPrimaryChange: props.onWizardPrimaryChange,
        onRequestAdvance: props.onRequestAdvance,
        isSaveNeeded: needsSave,
        isPrimaryDisabled: props.definition.isPrimaryDisabled({ needsSave, normalizedDraft, credentialRefs }),
        control: {
            configure,
            isBusy,
            isUnavailable,
            lastErrorMessage,
            activeTaskSnapshot,
            snapshot,
        },
        createConfig: async () => await props.definition.createConfig({ normalizedDraft, credentialRefs }),
    });

    React.useEffect(() => {
        const shouldPrefill = props.definition.fields.every((field) => draft[field.id].trim().length === 0);
        if (!shouldPrefill) {
            return;
        }

        const hasConfiguredValue = props.definition.fields.some((field) => configuredDraft[field.id].trim().length > 0);
        if (!hasConfiguredValue) {
            return;
        }

        setDraft(configuredDraft);
    }, [configuredDraft, draft, props.definition]);

    const handleChange = React.useCallback((fieldId: keyof RelayAccessConfigStepDraft, value: string) => {
        setDraft((currentDraft) => ({
            ...currentDraft,
            [fieldId]: value,
        }));
    }, []);

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.form}>
                {props.definition.fields.map((field) => (
                    <MachineSetupTextField
                        key={field.id}
                        testID={props.testID ? `${props.testID}-${field.id}` : `${props.definition.testIDPrefix}-${field.id}`}
                        label={field.label}
                        placeholder={field.placeholder}
                        autoCapitalize={field.autoCapitalize}
                        autoCorrect={field.autoCorrect}
                        value={draft[field.id]}
                        onChangeText={(value) => handleChange(field.id, value)}
                    />
                ))}
                <RelayAccessCredentialFields
                    descriptor={props.definition.descriptor}
                    value={credentialRefs}
                    accountScope={actionScope}
                    onChange={setCredentialRefsDraft}
                    disabled={isBusy || isUnavailable}
                    testIDPrefix={props.testID ?? props.definition.testIDPrefix}
                />
                <Text style={styles.hint}>{props.definition.hint}</Text>
            </View>

            {typeof lastErrorMessage === 'string' && lastErrorMessage.trim().length > 0 ? (
                <Text style={styles.hint}>{lastErrorMessage}</Text>
            ) : null}

            <RelayAccessWizardBusyOverlay
                testID={props.testID ? `${props.testID}-busyOverlay` : `${props.definition.testIDPrefix}-busyOverlay`}
                snapshot={activeTaskSnapshot}
                visible={isBusy && activeTaskSnapshot != null}
            />
        </View>
    );
});
