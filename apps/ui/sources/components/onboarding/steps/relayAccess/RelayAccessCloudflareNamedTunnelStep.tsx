import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { StyleSheet as UnistylesStyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { getDefaultSystemTaskRunner, SystemTaskProgressCard } from '@/components/systemTasks';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { setActiveShareableServerUrl, setServerProfileShareableUrl } from '@/sync/domains/server/serverRuntime';

import { useLocalRelayAccessControl } from '@/components/settings/server/localControl/useLocalRelayAccessControl';

const stylesheet = UnistylesStyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 12,
    },
    form: {
        width: '100%',
        gap: 10,
    },
    hint: {
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

export type RelayAccessCloudflareNamedTunnelStepProps = Readonly<{
    testID?: string;
    runner?: SystemTaskRunner;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    onWizardPrimaryChange?: (state: Readonly<{
        label: string;
        disabled: boolean;
        onPress: (() => void) | (() => Promise<void>);
    }> | null) => void;
    onRequestAdvance?: () => void;
}>;

export const RelayAccessCloudflareNamedTunnelStep = React.memo(function RelayAccessCloudflareNamedTunnelStep(props: RelayAccessCloudflareNamedTunnelStepProps) {
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
    } = useLocalRelayAccessControl({ runner, upstreamUrl: props.upstreamUrl ?? null, target: props.target });

    const [hostnameDraft, setHostnameDraft] = React.useState('');
    const [tokenDraft, setTokenDraft] = React.useState('');
    const [advanceAfterSaveRequested, setAdvanceAfterSaveRequested] = React.useState(false);

    const handleSave = React.useCallback(async (): Promise<boolean> => {
        if (isUnavailable) {
            return false;
        }
        const hostname = hostnameDraft.trim();
        const token = tokenDraft.trim();
        if (!hostname) {
            await Modal.alert(t('common.error'), t('settings.relayAccess.missingHostname'));
            return false;
        }
        if (!token) {
            await Modal.alert(t('common.error'), t('settings.relayAccess.missingToken'));
            return false;
        }
        const taskId = await configure({
            providerId: 'cloudflareNamed',
            config: { providerId: 'cloudflareNamed', hostname, token },
        });
        return Boolean(taskId);
    }, [configure, hostnameDraft, isUnavailable, tokenDraft]);

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
            disabled: isBusy || isUnavailable || hostnameDraft.trim().length === 0 || tokenDraft.trim().length === 0,
            onPress: handlePrimaryPress,
        });
        return () => props.onWizardPrimaryChange?.(null);
    }, [handlePrimaryPress, hostnameDraft, isBusy, isUnavailable, props.onWizardPrimaryChange, tokenDraft]);

    React.useEffect(() => {
        if (!snapshot) {
            return;
        }
        const shareUrl = snapshot.status?.shareUrl ?? null;
        if (props.serverProfileId) {
            setServerProfileShareableUrl(props.serverProfileId, shareUrl, {
                validatedAgainstServerUrl: props.upstreamUrl ?? null,
            });
            return;
        }
        setActiveShareableServerUrl(shareUrl, {
            validatedAgainstServerUrl: props.upstreamUrl ?? null,
        });
    }, [props.serverProfileId, props.upstreamUrl, snapshot]);

    React.useEffect(() => {
        if (!advanceAfterSaveRequested) return;
        if (isBusy) return;
        if (!snapshot) {
            setAdvanceAfterSaveRequested(false);
            return;
        }
        if (snapshot.configured === true && snapshot.providerId === 'cloudflareNamed') {
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
            <View style={styles.form}>
                <MachineSetupTextField
                    testID={props.testID ? `${props.testID}-hostname` : 'relay-access-cloudflare-hostname'}
                    label={t('settings.relayAccess.fields.hostnameLabel')}
                    placeholder={t('settings.relayAccess.fields.hostnameLabel')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={hostnameDraft}
                    onChangeText={setHostnameDraft}
                />
                <MachineSetupTextField
                    testID={props.testID ? `${props.testID}-token` : 'relay-access-cloudflare-token'}
                    label={t('settings.relayAccess.fields.tokenLabel')}
                    placeholder={t('settings.relayAccess.fields.tokenLabel')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={true}
                    value={tokenDraft}
                    onChangeText={setTokenDraft}
                />
                <Text style={styles.hint}>{t('setupOnboarding.relayAccessCloudflareBody')}</Text>
            </View>

            {typeof lastErrorMessage === 'string' && lastErrorMessage.trim().length > 0 ? (
                <Text style={styles.hint}>{lastErrorMessage}</Text>
            ) : null}

            {showBusyOverlay ? (
                <View testID={props.testID ? `${props.testID}-busyOverlay` : 'relay-access-cloudflare-busyOverlay'} style={styles.overlay}>
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
                                (createBackdropWebStyle({ backgroundColor: overlayScrimColor, blurPx: 2 }) as unknown as Record<string, unknown>),
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
