import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { StyleSheet as UnistylesStyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { getDefaultSystemTaskRunner, SystemTaskProgressCard } from '@/components/systemTasks';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';

import { useLocalRelayAccessControl } from '@/components/settings/server/localControl/useLocalRelayAccessControl';

const stylesheet = UnistylesStyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 12,
    },
    urlBlock: {
        width: '100%',
        gap: 10,
    },
    urlHint: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        borderRadius: 12,
        overflow: 'hidden',
    },
    overlayCard: {
        width: '100%',
        maxWidth: 420,
    },
}));

export type RelayAccessLanUrlStepProps = Readonly<{
    testID?: string;
    runner?: SystemTaskRunner;
    upstreamUrl?: string | null;
    onWizardPrimaryChange?: (state: Readonly<{
        label: string;
        disabled: boolean;
        onPress: (() => void) | (() => Promise<void>);
    }> | null) => void;
    onRequestAdvance?: () => void;
}>;

export const RelayAccessLanUrlStep = React.memo(function RelayAccessLanUrlStep(props: RelayAccessLanUrlStepProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const {
        activeTaskSnapshot,
        configure,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        snapshot,
    } = useLocalRelayAccessControl({ runner, upstreamUrl: props.upstreamUrl ?? null });

    const [urlDraft, setUrlDraft] = React.useState('');
    const [advanceAfterSaveRequested, setAdvanceAfterSaveRequested] = React.useState(false);

    const handleSave = React.useCallback(async (): Promise<boolean> => {
        if (isUnavailable) {
            return false;
        }
        const normalized = urlDraft.trim();
        if (!normalized) {
            await Modal.alert(t('common.error'), t('settings.relayAccess.missingUrl'));
            return false;
        }
        const taskId = await configure({
            providerId: 'lan',
            config: { providerId: 'lan', url: normalized },
        });
        return Boolean(taskId);
    }, [configure, isUnavailable, urlDraft]);

    const handlePrimaryPress = React.useCallback(async () => {
        const started = await handleSave();
        if (!started) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        setAdvanceAfterSaveRequested(true);
    }, [handleSave]);

    React.useEffect(() => {
        if (!props.onWizardPrimaryChange) return;
        props.onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: isBusy || isUnavailable || urlDraft.trim().length === 0,
            onPress: handlePrimaryPress,
        });
        return () => props.onWizardPrimaryChange?.(null);
    }, [handlePrimaryPress, isBusy, isUnavailable, props.onWizardPrimaryChange, urlDraft]);

    React.useEffect(() => {
        if (!advanceAfterSaveRequested) return;
        if (isBusy) return;
        if (!snapshot) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        if (snapshot.configured === true && snapshot.providerId === 'lan') {
            setAdvanceAfterSaveRequested(false);
            props.onRequestAdvance?.();
            return;
        }
        setAdvanceAfterSaveRequested(false);
    }, [advanceAfterSaveRequested, isBusy, props.onRequestAdvance, snapshot]);

    const overlayScrimColor = theme.colors.overlay?.scrimWizard ?? theme.colors.surface;
    const showBusyOverlay = isBusy && activeTaskSnapshot != null;

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.urlBlock}>
                <MachineSetupTextField
                    testID={props.testID ? `${props.testID}-url` : 'relay-access-lan-url'}
                    label={t('settings.relayAccess.fields.urlLabel')}
                    placeholder={t('common.urlPlaceholder')}
                    value={urlDraft}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setUrlDraft}
                />
                <Text style={styles.urlHint}>{t('setupOnboarding.relayAccessUrlBody')}</Text>
            </View>

            {typeof lastErrorMessage === 'string' && lastErrorMessage.trim().length > 0 ? (
                <Text style={styles.urlHint}>{lastErrorMessage}</Text>
            ) : null}

            {showBusyOverlay ? (
                <View testID={props.testID ? `${props.testID}-busyOverlay` : 'relay-access-lan-busyOverlay'} style={styles.overlay}>
                    {Platform.OS !== 'web' ? (
                        (() => {
                            try {
                                // eslint-disable-next-line @typescript-eslint/no-var-requires
                                const { BlurView } = require('expo-blur');
                                if (BlurView) {
                                    return (
                                        <BlurView
                                            intensity={Platform.OS === 'ios' ? 12 : 3}
                                            tint="default"
                                            pointerEvents="none"
                                            style={StyleSheet.absoluteFillObject}
                                        />
                                    );
                                }
                            } catch {
                                // fall back
                            }
                            return (
                                <View
                                    pointerEvents="none"
                                    style={[
                                        StyleSheet.absoluteFillObject,
                                        createBackdropNativeStyle({ backgroundColor: overlayScrimColor }),
                                    ]}
                                />
                            );
                        })()
                    ) : (
                        <View
                            pointerEvents="none"
                            style={[
                                StyleSheet.absoluteFillObject,
                                (createBackdropWebStyle({ backgroundColor: overlayScrimColor, blurPx: 12 }) as unknown as Record<string, unknown>),
                            ]}
                        />
                    )}
                    <View style={styles.overlayCard}>
                        <SystemTaskProgressCard
                            snapshot={activeTaskSnapshot}
                            variant="checklistOnly"
                            title={null}
                            showStepMessages={false}
                            showOpenLogs={false}
                        />
                    </View>
                </View>
            ) : null}
        </View>
    );
});
