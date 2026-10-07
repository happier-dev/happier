import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { useUnistyles } from 'react-native-unistyles';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { presentProviderError, presentProviderRecoveryAction } from '@/providers/connection/errorPresentation';
import { dispatchProviderRecoveryAction } from '@/providers/connection/recovery';
import { t } from '@/text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export const ProviderErrorItems = React.memo(function ProviderErrorItems(props: Readonly<{
    error: unknown;
    /**
     * `'rows'` (default): the settings anatomy — a titled info row with its description, and the
     * recovery action as a row beneath. `'line'`: one compact line inside a picker — the severity
     * glyph (its tooltip and accessible name carry the description), the title, and the recovery
     * action as an icon-only control.
     */
    presentation?: 'rows' | 'line';
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
        ? 'warning-circle'
        : presentation.severity === 'warning'
            ? 'warning'
            : 'info';
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

    if (props.presentation === 'line') {
        const code = typedError.success ? typedError.data.code : 'unknown';
        const actionTitle = actionPresentation && typedError.success ? t(actionPresentation.titleKey) : null;
        return (
            <View
                testID={`provider-error:${code}`}
                accessibilityLiveRegion="polite"
                style={lineStyles.line}
            >
                <Tooltip
                    testID={`provider-error-detail:${code}`}
                    label={t(presentation.descriptionKey)}
                >
                    <Icon name={iconName} size={ICON_SIZE.sm} color={iconColor} />
                </Tooltip>
                <Text numberOfLines={1} style={lineStyles.title}>{t(presentation.titleKey)}</Text>
                {actionTitle ? (
                    <IconButton
                        testID={`provider-error-action:${code}`}
                        iconName={actionPresentation?.titleKey === 'settingsProviders.errors.actions.retry' ? 'arrow-clockwise' : 'caret-right'}
                        accessibilityLabel={actionTitle}
                        tooltip={actionTitle}
                        variant="plain"
                        size={24}
                        iconSize={ICON_SIZE.sm}
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                        disabled={recoveryPending}
                        onPress={() => void runRecovery()}
                    />
                ) : null}
            </View>
        );
    }

    return (
        <>
            <View accessibilityLiveRegion="polite">
                <Item
                    testID={typedError.success ? `provider-error:${typedError.data.code}` : 'provider-error:unknown'}
                    mode="info"
                    title={t(presentation.titleKey)}
                    subtitle={t(presentation.descriptionKey)}
                    icon={<Icon name={iconName} size={29} color={iconColor} />}
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

const lineStyles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 24,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
