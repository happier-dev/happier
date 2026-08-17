import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { Modal } from '@/modal';
import { t, tLoose } from '@/text';

export type FirstKeyRecoveryActionResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'recovery_failed' }>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingVertical: 16,
        gap: 12,
    },
    description: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
    danger: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
        marginTop: 4,
    },
    dangerText: {
        color: theme.colors.text.destructive,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
}));

type Props = CustomModalInjectedProps & Readonly<{
    finish: () => Promise<FirstKeyRecoveryActionResult>;
    abandon: () => Promise<FirstKeyRecoveryActionResult>;
    onSettled: (
        outcome: 'finish' | 'abandon' | 'keep',
    ) => void;
}>;

export function FirstKeyRecoveryModal(
    props: Props,
): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [busy, setBusy] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const inFlightRef = React.useRef(false);
    const run = React.useCallback(async (
        action: () => Promise<FirstKeyRecoveryActionResult>,
        outcome: 'finish' | 'abandon',
    ) => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy(true);
        setFailed(false);
        const result = await action()
            .catch(() => ({ kind: 'recovery_failed' as const }));
        if (result.kind === 'completed') {
            props.onSettled(outcome);
            props.onClose();
            return;
        }
        inFlightRef.current = false;
        setFailed(true);
        setBusy(false);
    }, [props]);
    const abandon = React.useCallback(async () => {
        if (busy) return;
        const confirmed = await Modal.confirm(
            tLoose(
                'settingsAccount.firstKeyRecovery.abandonConfirmTitle',
            ),
            tLoose(
                'settingsAccount.firstKeyRecovery.warning',
            ),
            {
                cancelText: t('common.cancel'),
                confirmText: tLoose(
                    'settingsAccount.firstKeyRecovery.abandon',
                ),
                destructive: true,
            },
        );
        if (!confirmed) return;
        await run(props.abandon, 'abandon');
    }, [busy, props.abandon, run]);
    const footer = React.useMemo(() => (
        <View style={styles.body}>
            <RoundButton
                title={tLoose(
                    'settingsAccount.firstKeyRecovery.finish',
                )}
                size="normal"
                action={async () => await run(
                    props.finish,
                    'finish',
                )}
                disabled={busy}
                loading={busy}
                testID="first-key-recovery-finish"
            />
            <RoundButton
                title={tLoose(
                    'settingsAccount.firstKeyRecovery.keep',
                )}
                size="normal"
                display="inverted"
                onPress={() => {
                    props.onSettled('keep');
                    props.onClose();
                }}
                disabled={busy}
                testID="first-key-recovery-keep"
            />
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={tLoose(
                    'settingsAccount.firstKeyRecovery.abandon',
                )}
                onPress={() => {
                    void abandon();
                }}
                disabled={busy}
                style={styles.danger}
                testID="first-key-recovery-abandon"
            >
                <Text style={styles.dangerText}>
                    {tLoose(
                        'settingsAccount.firstKeyRecovery.abandon',
                    )}
                </Text>
            </Pressable>
        </View>
    ), [abandon, busy, props, run, styles]);
    useModalCardChrome(props.setChrome, {
        kind: 'card',
        title: tLoose(
            'settingsAccount.firstKeyRecovery.title',
        ),
        testID: 'first-key-recovery-modal',
        closeButtonTestID: 'first-key-recovery-close',
        footer,
        dimensions: {
            width: 420,
            maxHeightRatio: 0.85,
            size: 'dialog',
        },
    });

    return (
        <View style={styles.body}>
            <Text style={styles.description}>
                {tLoose(
                    'settingsAccount.firstKeyRecovery.description',
                )}
            </Text>
            <Text style={[
                styles.description,
                { color: theme.colors.text.destructive },
            ]}>
                {tLoose(
                    'settingsAccount.firstKeyRecovery.warning',
                )}
            </Text>
            {failed ? (
                <Text
                    style={styles.description}
                    testID="first-key-recovery-error"
                >
                    {tLoose(
                        'settingsAccount.firstKeyRecovery.failed',
                    )}
                </Text>
            ) : null}
        </View>
    );
}
