import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';
import {
    resolveLocalServicePortLabel,
    resolveManagedFactLines,
    resolveManagedStatusLabel,
} from '@/sync/domains/local/services/presentation';
import { t } from '@/text';

import { LocalServiceFactList } from './LocalServiceFactList';
import { ManagedLocalServiceStatus } from './ManagedLocalServiceStatus';
import { ManagedServiceStatusDot } from './ServiceStatusDot';

export type ManagedLocalServiceStopHandler = (row: ManagedLocalServiceStoreRow) => void | Promise<unknown>;
export type ManagedLocalServiceRestartHandler = (row: ManagedLocalServiceStoreRow) => void | Promise<unknown>;

const stylesheet = StyleSheet.create((theme) => ({
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        flexShrink: 1,
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    port: {
        ...Typography.mono(),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    right: {
        alignItems: 'flex-end',
        gap: 8,
    },
    actionButtons: {
        flexDirection: 'row',
        gap: 6,
    },
}));

function ManagedServiceTitle(props: Readonly<{
    row: ManagedLocalServiceStoreRow;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const title = props.row.ownerLabel ?? props.row.routeName ?? props.row.url ?? props.row.id;
    const portLabel = resolveLocalServicePortLabel(props.row);
    return (
        <View style={styles.titleRow}>
            <ManagedServiceStatusDot
                phase={props.row.phase}
                animationEnabled={props.animationEnabled}
                testID={`${props.testID}-dot`}
                accessibilityLabel={resolveManagedStatusLabel(props.row.phase)}
            />
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            {portLabel ? (
                <Text testID={`${props.testID}-port`} style={styles.port} numberOfLines={1}>{portLabel}</Text>
            ) : null}
        </View>
    );
}

export function ManagedLocalServiceRow(props: Readonly<{
    row: ManagedLocalServiceStoreRow;
    onStop?: ManagedLocalServiceStopHandler;
    onRestart?: ManagedLocalServiceRestartHandler;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const facts = React.useMemo(() => resolveManagedFactLines(props.row), [props.row]);
    const styles = stylesheet;
    const canStop = props.row.phase === 'running'
        && props.row.supportedActions.includes('stop_managed')
        && Boolean(props.onStop);
    const canRestart = props.row.phase === 'running'
        && props.row.supportedActions.includes('restart_managed')
        && Boolean(props.onRestart);
    const handleStop = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('localServices.actions.stopConfirmTitle'),
            t('localServices.actions.stopConfirmMessage', {
                service: props.row.ownerLabel ?? props.row.routeName ?? props.row.url ?? props.row.id,
            }),
            {
                confirmText: t('localServices.actions.stopConfirmCta'),
                destructive: true,
            },
        );
        if (confirmed) {
            await props.onStop?.(props.row);
        }
    }, [props.onStop, props.row]);
    const handleRestart = React.useCallback(() => props.onRestart?.(props.row), [props.onRestart, props.row]);
    const hasActions = canStop || canRestart;

    return (
        <Item
            testID={props.testID}
            title={(
                <ManagedServiceTitle
                    row={props.row}
                    animationEnabled={props.animationEnabled}
                    testID={props.testID}
                />
            )}
            subtitle={<LocalServiceFactList lines={facts} testID={`${props.testID}-facts`} />}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={hasActions ? (
                <View style={styles.right}>
                    <ManagedLocalServiceStatus phase={props.row.phase} testID={props.testID} />
                    <View style={styles.actionButtons}>
                        {canRestart ? (
                            <IconButton
                                testID={`${props.testID}-restart`}
                                iconName="refresh-outline"
                                accessibilityLabel={t('localServices.managed.restartActionA11y')}
                                animationEnabled={props.animationEnabled}
                                onPress={handleRestart}
                            />
                        ) : null}
                        {canStop ? (
                            <IconButton
                                testID={`${props.testID}-stop`}
                                iconName="stop-circle-outline"
                                accessibilityLabel={t('localServices.managed.stopActionA11y')}
                                tone="danger"
                                animationEnabled={props.animationEnabled}
                                onPress={handleStop}
                            />
                        ) : null}
                    </View>
                </View>
            ) : (
                <ManagedLocalServiceStatus phase={props.row.phase} testID={props.testID} />
            )}
        />
    );
}
