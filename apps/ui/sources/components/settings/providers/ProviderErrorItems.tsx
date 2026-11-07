import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

import { SurfaceStateCard, type SurfaceStateSize } from '@/components/ui/surfaces/SurfaceStateCard';
import { presentProviderError, presentProviderRecoveryAction } from '@/providers/connection/errorPresentation';
import { dispatchProviderRecoveryAction } from '@/providers/connection/recovery';
import { t } from '@/text';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';

const styles = StyleSheet.create({
    /** A state inside a settings group stands on the rows' own padding, like the rows around it. */
    inlineInGroup: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingVertical: PAGE_LIST_METRICS.rowPaddingVerticalPx,
    },
});

export const ProviderErrorItems = React.memo(function ProviderErrorItems(props: Readonly<{
    error: unknown;
    /**
     * `'rows'` (default): one shared surface state with its cause and recovery.
     * `'line'`: one compact line inside a picker — the severity
     * glyph (its tooltip and accessible name carry the description), the title, and the recovery
     * action as an icon-only control.
     */
    presentation?: 'rows' | 'line';
    /** Rails use the shared compact state; page errors keep the enclosing surface's size. */
    size?: SurfaceStateSize;
    /** `'inline'`: the failure sits in a settings group beside the control that caused it, so it takes the compact inline anatomy on the rows' padding instead of a page-sized centred card. */
    layout?: 'inline';
    /** The source the failure is about (a connection); a `'line'` leads with it so a list of failures stays attributable. */
    subject?: string | null;
    retry?: () => void | Promise<void>;
    loadModel?: () => void | Promise<void>;
    reviewAndRestart?: () => void | Promise<void>;
    reviewConnection?: () => void | Promise<void>;
    reviewCurrentState?: () => void | Promise<void>;
    configureSecret?: (event?: unknown) => void | Promise<void>;
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
    const runRecovery = async (event?: unknown) => {
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
                configureSecret: props.configureSecret ? () => props.configureSecret?.(event) : undefined,
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
            <NoticeLine
                testID={`provider-error:${code}`}
                tooltipTestID={`provider-error-detail:${code}`}
                iconName={iconName}
                iconColor={iconColor}
                tooltip={t(presentation.descriptionKey)}
                subject={props.subject}
                title={t(presentation.titleKey)}
                action={actionTitle ? {
                    testID: `provider-error-action:${code}`,
                    label: actionTitle,
                    iconName: actionPresentation?.titleKey === 'settingsProviders.errors.actions.retry' ? 'arrow-clockwise' : 'caret-right',
                    disabled: recoveryPending,
                    onPress: (event) => void runRecovery(event),
                } : undefined}
            />
        );
    }

    const code = typedError.success ? typedError.data.code : 'unknown';
    const card = <SurfaceStateCard
        testID={`provider-error:${code}`}
        size={props.size}
        layout={props.layout}
        kind={presentation.severity === 'danger' ? 'error' : presentation.severity === 'warning' ? 'warning' : 'unavailable'}
        title={t(presentation.titleKey)}
        reason={t(presentation.descriptionKey)}
        // Details names the shared Action cause when one exists, and the request to quote to support.
        diagnosticCode={presentation.context.failureCause?.errorCode ?? code}
        diagnosticDetail={presentation.context.requestId ?? null}
        accessibilitySemantics="status"
        action={actionPresentation && typedError.success ? {
            testID: `provider-error-action:${code}`,
            label: t(actionPresentation.titleKey),
            busy: recoveryPending,
            disabled: recoveryPending,
            onPress: runRecovery,
        } : undefined}
    />;
    return props.layout === 'inline' ? <View style={styles.inlineInGroup}>{card}</View> : card;
});
