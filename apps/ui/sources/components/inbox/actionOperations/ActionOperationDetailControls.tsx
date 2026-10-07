import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { ActionOperationStopTarget } from './requestActionOperationStop';

import { useActionOperationStopControl } from './useActionOperationStopControl';

export function ActionOperationDetailControls(props: Readonly<{
    operation?: ActionOperationStopTarget;
    terminal: boolean;
    canCancel: boolean;
    onClose: () => void;
    leading?: React.ReactNode;
}>) {
    const stopControl = useActionOperationStopControl(props.operation);
    return (
        <View style={styles.container}>
            {props.canCancel && stopControl.feedback ? (
                <Text
                    testID="action-operation-cancel-feedback"
                    accessibilityLiveRegion="polite"
                    role="status"
                    style={styles.feedback}
                >
                    {stopControl.feedback === 'requested'
                        ? t('inbox.actionOperations.cancel.requested')
                        : stopControl.feedback === 'already_settled'
                            ? t('inbox.actionOperations.cancel.alreadySettled')
                            : stopControl.feedback === 'unsupported'
                                ? t('inbox.actionOperations.cancel.unsupported')
                                : stopControl.feedback === 'not_found'
                                    ? t('inbox.actionOperations.cancel.notFound')
                                    : t('inbox.actionOperations.cancel.failed')}
                </Text>
            ) : null}
            <View style={styles.actions}>
                {props.leading}
                {props.canCancel ? (
                    <RoundButton
                        display="inverted"
                        title={stopControl.pending ? t('runs.stop.stoppingLabel') : t('inbox.actionOperations.cancel.stop')}
                        testID="action-operation-cancel"
                        loading={stopControl.pending}
                        disabled={stopControl.pending || stopControl.feedback === 'requested'}
                        onPress={stopControl.requestStop}
                    />
                ) : null}
                <RoundButton
                    display="inverted"
                    title={props.terminal ? t('common.done') : t('common.collapse')}
                    testID={props.terminal ? 'action-operation-done' : 'action-operation-collapse'}
                    onPress={props.onClose}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        gap: 8,
    },
    feedback: {
        color: theme.colors.text.primary,
        textAlign: 'right',
    },
    actions: {
        minHeight: 44,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
    },
}));
