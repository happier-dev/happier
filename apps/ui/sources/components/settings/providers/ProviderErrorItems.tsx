import * as React from 'react';
import { useRouter } from 'expo-router';
import { ProviderErrorV1Schema } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import { View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { presentProviderError, presentProviderRecoveryAction } from '@/providers/connection/errorPresentation';
import { dispatchProviderRecoveryAction } from '@/providers/connection/recovery';
import { t } from '@/text';

export const ProviderErrorItems = React.memo(function ProviderErrorItems(props: Readonly<{
    error: unknown;
    retry?: () => void | Promise<void>;
    loadModel?: () => void | Promise<void>;
    reviewAndRestart?: () => void | Promise<void>;
    reviewConnection?: () => void | Promise<void>;
    reviewCurrentState?: () => void | Promise<void>;
    configureSecret?: () => void | Promise<void>;
    enableOnMachine?: () => void | Promise<void>;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const recoveryInFlightRef = React.useRef(false);
    const [recoveryPending, setRecoveryPending] = React.useState(false);
    const presentation = presentProviderError(props.error);
    const typedError = ProviderErrorV1Schema.safeParse(props.error);
    const actionPresentation = presentProviderRecoveryAction(props.error, {
        retry: props.retry !== undefined,
        loadModel: props.loadModel !== undefined,
        reviewAndRestart: props.reviewAndRestart !== undefined,
        reviewConnection: props.reviewConnection !== undefined,
        reviewCurrentState: props.reviewCurrentState !== undefined,
        configureSecret: props.configureSecret !== undefined,
        enableOnMachine: props.enableOnMachine !== undefined,
    });
    const iconName = presentation.severity === 'danger'
        ? 'alert-circle-outline'
        : presentation.severity === 'warning'
            ? 'warning-outline'
            : 'information-circle-outline';
    const iconColor = presentation.severity === 'danger'
        ? theme.colors.state.danger.foreground
        : presentation.severity === 'warning'
            ? theme.colors.state.warning.foreground
            : theme.colors.text.secondary;
    const runRecovery = async () => {
        if (!typedError.success || recoveryInFlightRef.current) return;
        recoveryInFlightRef.current = true;
        setRecoveryPending(true);
        try {
            await dispatchProviderRecoveryAction({
                error: typedError.data,
                router,
                retry: props.retry,
                loadModel: props.loadModel,
                reviewAndRestart: props.reviewAndRestart,
                reviewConnection: props.reviewConnection,
                reviewCurrentState: props.reviewCurrentState,
                configureSecret: props.configureSecret,
                enableOnMachine: props.enableOnMachine,
            });
        } catch {
            // Recovery callbacks own their user-facing failure state.
        } finally {
            recoveryInFlightRef.current = false;
            setRecoveryPending(false);
        }
    };

    return (
        <>
            <View accessibilityLiveRegion="polite">
                <Item
                    testID={typedError.success ? `provider-error:${typedError.data.code}` : 'provider-error:unknown'}
                    mode="info"
                    title={t(presentation.titleKey)}
                    subtitle={t(presentation.descriptionKey)}
                    icon={<SafeIonicons name={iconName} size={29} color={iconColor} />}
                />
            </View>
            {actionPresentation && typedError.success ? (
                <Item
                    testID={typedError.success ? `provider-error-action:${typedError.data.code}` : 'provider-error-action:unknown'}
                    title={t(actionPresentation.titleKey)}
                    loading={recoveryPending}
                    disabled={recoveryPending}
                    onPress={() => void runRecovery()}
                />
            ) : null}
        </>
    );
});
