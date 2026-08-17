import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ServiceRow, ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import type { TranslationKey } from '@/text/i18n';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { LocalServicePublicPreviewControls } from './LocalServicePublicPreviewControls';
import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type {
    ManagedLocalServiceRestartHandler,
    ManagedLocalServiceStopHandler,
} from './ManagedLocalServiceRow';
import { LaunchTargetStatusDot } from './ServiceStatusDot';

export type ServiceRowOpenHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowStartHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowTerminateHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;

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
    facts: {
        gap: 2,
    },
    factRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
    },
    factText: {
        color: theme.colors.text.secondary,
    },
    reasonText: {
        color: theme.colors.text.secondary,
    },
    right: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    statusStack: {
        alignItems: 'flex-end',
        gap: 6,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));

const STATUS_LABEL_KEYS: Readonly<Record<ServiceRowStatus, TranslationKey>> = {
    running: 'localServices.rowStatus.running',
    starting: 'localServices.rowStatus.starting',
    stale: 'localServices.rowStatus.stale',
    stopped: 'localServices.rowStatus.stopped',
    unavailable: 'localServices.rowStatus.unavailable',
};

const STATUS_VARIANTS: Readonly<Record<ServiceRowStatus, StatusPillVariant>> = {
    running: 'success',
    starting: 'info',
    stale: 'warning',
    stopped: 'neutral',
    unavailable: 'neutral',
};

function confirmServiceAction(input: Readonly<{
    title: string;
    message: string;
    confirmText: string;
}>): Promise<boolean> {
    return Modal.confirm(input.title, input.message, {
        confirmText: input.confirmText,
        destructive: true,
    });
}

function targetHasPreviewExposure(target: LocalServiceLaunchTarget): boolean {
    return target.source === 'registered_preview'
        || target.browserTarget?.kind === 'localServicePreview';
}

function targetHasPublicPreviewState(target: LocalServiceLaunchTarget): boolean {
    return targetHasPreviewExposure(target)
        || (target.source === 'inventory_entry' && target.browserTarget?.kind === 'externalUrl');
}

function ServiceRowTitle(props: Readonly<{
    row: ServiceRow;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View style={styles.titleRow}>
            <LaunchTargetStatusDot
                state={props.row.target.state}
                animationEnabled={props.animationEnabled}
                testID={`${props.testID}-dot`}
                accessibilityLabel={t(STATUS_LABEL_KEYS[props.row.status])}
            />
            <Text style={styles.title} numberOfLines={1}>{props.row.title}</Text>
            {props.row.portLabel ? (
                <Text testID={`${props.testID}-port`} style={styles.port} numberOfLines={1}>{props.row.portLabel}</Text>
            ) : null}
        </View>
    );
}

function ServiceAddressFact(props: Readonly<{
    addressValue: string;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const copyFeedback = useTemporaryCopyFeedback();
    const copyAddress = React.useCallback(async () => {
        const copied = await setClipboardStringSafe(props.addressValue);
        if (copied) {
            copyFeedback.markCopied('address');
        }
    }, [copyFeedback, props.addressValue]);
    return (
        <View style={styles.factRow}>
            <Text style={styles.factText}>{t('localServices.inventory.address', { value: props.addressValue })}</Text>
            <IconButton
                testID={`${props.testID}-copy-address`}
                iconName="copy"
                accessibilityLabel={t('localServices.actions.copyAddressA11y')}
                tooltip={t('localServices.actions.copyAddressA11y')}
                size={28}
                iconSize={14}
                variant="plain"
                onPress={copyAddress}
            />
            <CopiedPill
                visible={copyFeedback.isCopied('address')}
                testID={`${props.testID}-copy-address-feedback`}
            />
        </View>
    );
}

function ServiceRowFacts(props: Readonly<{ row: ServiceRow; testID: string }>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const reason = row.reasonCode
        ? resolveReasonCopy({ reasonCode: row.reasonCode, kind: 'localServiceLauncher' })
        : null;
    const addressValue = row.host
        ? `${row.scheme ? `${row.scheme}://` : ''}${row.host}${row.portLabel ?? ''}`
        : null;
    return (
        <View style={styles.facts}>
            {addressValue ? (
                <ServiceAddressFact addressValue={addressValue} testID={props.testID} />
            ) : null}
            {row.workspaceLabel ? (
                <Text style={styles.factText}>{t('localServices.inventory.workspace', { value: row.workspaceLabel })}</Text>
            ) : null}
            {row.processLabel ? (
                <Text style={styles.factText}>{t('localServices.inventory.process', { value: row.processLabel })}</Text>
            ) : null}
            {row.terminateIdentityConfidence === 'pid_only' ? (
                <Text testID={`${props.testID}-terminate-confidence`} style={styles.factText}>
                    {t('localServices.actions.terminatePidOnlyConfidence')}
                </Text>
            ) : null}
            <Text style={styles.factText}>{t(props.row.sourceLabel)}</Text>
            {reason ? (
                <Text
                    testID={`${props.testID}-reason`}
                    accessibilityHint={reason.diagnosticCode ?? undefined}
                    style={styles.reasonText}
                >
                    {reason.body}
                </Text>
            ) : null}
        </View>
    );
}

export function ServiceRowView(props: Readonly<{
    row: ServiceRow;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    onStartLauncherTarget?: ServiceRowStartHandler;
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onStopManagedService?: ManagedLocalServiceStopHandler;
    onRestartManagedService?: ManagedLocalServiceRestartHandler;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewActions?: LocalServicePublicPreviewActions;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const managed = row.managed;
    const isManagedRunning = managed?.phase === 'running';
    const canStop = isManagedRunning
        && (managed?.supportedActions.includes('stop_managed') ?? false)
        && Boolean(props.onStopManagedService);
    const canRestart = isManagedRunning
        && (managed?.supportedActions.includes('restart_managed') ?? false)
        && Boolean(props.onRestartManagedService);

    const primary = row.primaryAction;
    const canOpen = primary?.kind === 'open' && Boolean(props.onOpenServiceInBrowser);
    const canStart = primary?.kind === 'start' && Boolean(props.onStartLauncherTarget);
    const canTerminate = row.target.source === 'inventory_entry'
        && row.target.actions.includes('terminate_detected')
        && Boolean(props.onTerminateDetectedService);

    const handleOpen = React.useCallback(() => (
        primary?.kind === 'open' ? props.onOpenServiceInBrowser?.(primary.openTarget) : undefined
    ), [primary, props]);
    const handleStart = React.useCallback(() => (
        primary?.kind === 'start' ? props.onStartLauncherTarget?.(primary.target) : undefined
    ), [primary, props]);
    const handleStop = React.useCallback(async () => {
        if (!managed || !props.onStopManagedService) return;
        const confirmed = await confirmServiceAction({
            title: t('localServices.actions.stopConfirmTitle'),
            message: t('localServices.actions.stopConfirmMessage', { service: row.title }),
            confirmText: t('localServices.actions.stopConfirmCta'),
        });
        if (confirmed) {
            await props.onStopManagedService(managed);
        }
    }, [managed, props, row.title]);
    const handleTerminate = React.useCallback(async () => {
        if (!props.onTerminateDetectedService) return;
        const confirmed = await confirmServiceAction({
            title: t('localServices.actions.terminateConfirmTitle'),
            message: t('localServices.actions.terminateConfirmMessage', { service: row.title }),
            confirmText: t('localServices.actions.terminateConfirmCta'),
        });
        if (confirmed) {
            await props.onTerminateDetectedService(row.target);
        }
    }, [props, row.target, row.title]);
    const handleRestart = React.useCallback(
        () => (managed ? props.onRestartManagedService?.(managed) : undefined),
        [managed, props],
    );

    const hasActions = canOpen || canStart || canTerminate || canRestart || canStop;
    const showPublicPreview = targetHasPublicPreviewState(row.target)
        && Boolean(props.publicPreviewState)
        && Boolean(props.publicPreviewActions);

    return (
        <View testID={props.testID}>
            <Item
                testID={`${props.testID}-item`}
                title={(
                    <ServiceRowTitle row={row} animationEnabled={props.animationEnabled} testID={props.testID} />
                )}
                subtitle={<ServiceRowFacts row={row} testID={props.testID} />}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                rightElement={(
                    <View style={styles.right}>
                        <StatusPill
                            testID={`${props.testID}-status-${row.status}`}
                            variant={STATUS_VARIANTS[row.status]}
                            label={t(STATUS_LABEL_KEYS[row.status])}
                            isPulsing={row.status === 'running'}
                        />
                        {hasActions ? (
                            <View style={styles.actions}>
                                {canOpen ? (
                                    <IconButton
                                        testID={`${props.testID}-open`}
                                        iconName="arrow-square-out"
                                        accessibilityLabel={t('localServices.launcher.openInBrowserA11y')}
                                        animationEnabled={props.animationEnabled}
                                        onPress={handleOpen}
                                    />
                                ) : null}
                                {canStart ? (
                                    <IconButton
                                        testID={`${props.testID}-start`}
                                        iconName="play-circle"
                                        accessibilityLabel={t('common.start')}
                                        animationEnabled={props.animationEnabled}
                                        onPress={handleStart}
                                    />
                                ) : null}
                                {canTerminate ? (
                                    <IconButton
                                        testID={`${props.testID}-terminate`}
                                        iconName="x-circle"
                                        accessibilityLabel={t('localServices.actions.terminateDetectedA11y')}
                                        tone="danger"
                                        animationEnabled={props.animationEnabled}
                                        onPress={handleTerminate}
                                    />
                                ) : null}
                                {canRestart ? (
                                    <IconButton
                                        testID={`${props.testID}-restart`}
                                        iconName="arrow-clockwise"
                                        accessibilityLabel={t('localServices.managed.restartActionA11y')}
                                        animationEnabled={props.animationEnabled}
                                        onPress={handleRestart}
                                    />
                                ) : null}
                                {canStop ? (
                                    <IconButton
                                        testID={`${props.testID}-stop`}
                                        iconName="stop-circle"
                                        accessibilityLabel={t('localServices.managed.stopActionA11y')}
                                        tone="danger"
                                        animationEnabled={props.animationEnabled}
                                        onPress={handleStop}
                                    />
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                )}
            />
            {showPublicPreview ? (
                <LocalServicePublicPreviewControls
                    launchTargets={[row.target]}
                    state={props.publicPreviewState}
                    actions={props.publicPreviewActions}
                    testID={`${props.testID}-public-preview`}
                />
            ) : null}
        </View>
    );
}
