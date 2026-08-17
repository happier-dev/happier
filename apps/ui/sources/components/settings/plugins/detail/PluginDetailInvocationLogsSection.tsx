import * as React from 'react';
import type { PluginInvocationLogRecordV1 } from '@happier-dev/protocol';

import {
    resolvePluginMachineExecutionOriginPresentation,
    type PluginMachineExecutionOriginPresentation,
} from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import {
    type PluginMachineExecutionOriginSelectionV1,
} from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    readPluginInvocationLogsOnMachine,
    type PluginInvocationLogMachineReadTarget,
} from '@/sync/ops/pluginInvocationLogs';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import {
    usePluginInvocationLogsController,
    type PluginInvocationLogsControllerState,
} from './pluginInvocationLogsController';

export type PluginInvocationLogsTargetStatus = 'ready' | 'selectionRequired' | 'conflict' | 'unavailable';

const UNAVAILABLE_PLUGIN_INVOCATION_LOGS_STATE: PluginInvocationLogsControllerState = {
    phase: 'unavailable',
    unavailableReason: 'machineUnavailable',
    correlationId: '',
    records: [],
    cursor: null,
    hasMore: false,
    following: false,
};

const noOp = () => {};

function resolveTargetStatus(selection: PluginMachineExecutionOriginSelectionV1): PluginInvocationLogsTargetStatus {
    if (selection.state.kind === 'selectionRequired') return 'selectionRequired';
    if (selection.state.kind === 'conflict') return 'conflict';
    return selection.state.kind === 'selected' && selection.canExecute ? 'ready' : 'unavailable';
}

function exactOriginKey(selection: PluginMachineExecutionOriginSelectionV1): string | null {
    if (selection.state.kind !== 'selected' || !selection.canExecute) return null;
    const origin = selection.state.origin;
    return [
        origin.serverIdentityId,
        origin.materializationRef.machineId,
        origin.materializationRef.materializationId,
        origin.materializationRef.pluginId,
    ].map((part) => `${part.length}:${part}`).join('|');
}

function describeLogLevel(level: PluginInvocationLogRecordV1['level']): string {
    switch (level) {
        case 'debug': return t('settingsPlugins.invocationLogs.level.debug');
        case 'info': return t('settingsPlugins.invocationLogs.level.info');
        case 'warn': return t('settingsPlugins.invocationLogs.level.warn');
        case 'error': return t('settingsPlugins.invocationLogs.level.error');
        case 'diagnostic': return t('settingsPlugins.invocationLogs.level.diagnostic');
    }
}

function describeOccurredAt(occurredAtMs: number): string | null {
    if (!Number.isFinite(occurredAtMs)) return null;
    const occurredAt = new Date(occurredAtMs);
    if (!Number.isFinite(occurredAt.getTime())) return null;
    try {
        return formatWithCachedDateTimeFormatter(occurredAt, undefined, {
            dateStyle: 'medium',
            timeStyle: 'medium',
        });
    } catch {
        return null;
    }
}

function describeLogRecord(record: PluginInvocationLogRecordV1): string {
    return [
        describeLogLevel(record.level),
        describeOccurredAt(record.occurredAtMs),
        record.context.contribution.qualifiedId,
    ].filter((value): value is string => Boolean(value)).join(' · ');
}

/**
 * A daemon sequence is scoped to one host-stamped invocation. The tuple stays
 * stable across pagination/follow reconciliation without treating record text
 * or mutable fields as identity.
 */
export function pluginInvocationLogRowIdentity(record: PluginInvocationLogRecordV1): string {
    return [
        record.context.plugin.id,
        record.context.generation,
        record.context.correlationId,
        String(record.sequence),
    ].map((part) => `${part.length}:${part}`).join('|');
}

function describeTargetStatus(targetStatus: PluginInvocationLogsTargetStatus) {
    switch (targetStatus) {
        case 'selectionRequired':
            return {
                title: t('settingsPlugins.invocationLogs.selectionRequiredTitle'),
                subtitle: t('settingsPlugins.invocationLogs.selectionRequiredSubtitle'),
            };
        case 'conflict':
            return {
                title: t('settingsPlugins.invocationLogs.conflictTitle'),
                subtitle: t('settingsPlugins.invocationLogs.conflictSubtitle'),
            };
        case 'unavailable':
            return {
                title: t('settingsPlugins.invocationLogs.unavailableTitle'),
                subtitle: t('settingsPlugins.invocationLogs.unavailableSubtitle'),
            };
        case 'ready':
            return null;
    }
}

export function PluginDetailInvocationLogsSectionView(props: Readonly<{
    pluginId: string;
    targetStatus: PluginInvocationLogsTargetStatus;
    targetPresentation?: PluginMachineExecutionOriginPresentation;
    state: PluginInvocationLogsControllerState;
    onEditCorrelationId: () => void;
    onRefresh: () => void;
    onLoadMore: () => void;
    onStartFollowing: () => void;
    onStopFollowing: () => void;
}>) {
    const testIDPrefix = `settings.plugins.detail.${props.pluginId}.invocationLogs`;
    const canRead = props.targetStatus === 'ready';
    const isReading = props.state.phase === 'loading';
    const targetStatus = describeTargetStatus(props.targetStatus);
    const correlationId = props.state.correlationId;
    const hasRetainedRecords = props.state.records.length > 0;
    const unavailableSubtitle = props.state.unavailableReason === 'readerUnavailable'
        ? t('settingsPlugins.invocationLogs.readerUnavailableSubtitle')
        : t('settingsPlugins.invocationLogs.unavailableSubtitle');
    const errorNotice = !targetStatus && props.state.phase === 'error' && hasRetainedRecords ? (
        <Item
            testID={`${testIDPrefix}.error`}
            title={t('settingsPlugins.invocationLogs.errorTitle')}
            subtitle={t('settingsPlugins.invocationLogs.errorSubtitle')}
            accessibilityLiveRegion="polite"
            mode="info"
            showChevron={false}
        />
    ) : null;

    let content: React.ReactNode;
    if (targetStatus) {
        content = (
            <Item
                testID={`${testIDPrefix}.targetStatus`}
                title={targetStatus.title}
                subtitle={targetStatus.subtitle}
                accessibilityLiveRegion="polite"
                mode="info"
                showChevron={false}
            />
        );
    } else if (props.state.phase === 'unavailable') {
        content = (
            <Item
                testID={`${testIDPrefix}.unavailable`}
                title={t('settingsPlugins.invocationLogs.unavailableTitle')}
                subtitle={unavailableSubtitle}
                accessibilityLiveRegion="polite"
                mode="info"
                showChevron={false}
            />
        );
    } else if (props.state.phase === 'error' && !hasRetainedRecords) {
        content = (
            <Item
                testID={`${testIDPrefix}.error`}
                title={t('settingsPlugins.invocationLogs.errorTitle')}
                subtitle={t('settingsPlugins.invocationLogs.errorSubtitle')}
                accessibilityLiveRegion="polite"
                mode="info"
                showChevron={false}
            />
        );
    } else if (isReading && props.state.records.length === 0) {
        content = (
            <Item
                testID={`${testIDPrefix}.loading`}
                title={t('settingsPlugins.invocationLogs.loadingTitle')}
                subtitle={t('settingsPlugins.invocationLogs.loadingSubtitle')}
                accessibilityLiveRegion="polite"
                loading
                mode="info"
                showChevron={false}
            />
        );
    } else if (props.state.phase === 'idle') {
        content = (
            <Item
                testID={`${testIDPrefix}.idle`}
                title={t('settingsPlugins.invocationLogs.idleTitle')}
                subtitle={t('settingsPlugins.invocationLogs.idleSubtitle')}
                accessibilityLiveRegion="polite"
                mode="info"
                showChevron={false}
            />
        );
    } else if (props.state.records.length === 0) {
        content = (
            <Item
                testID={`${testIDPrefix}.empty`}
                title={t('settingsPlugins.invocationLogs.emptyTitle')}
                subtitle={t('settingsPlugins.invocationLogs.emptySubtitle')}
                accessibilityLiveRegion="polite"
                mode="info"
                showChevron={false}
            />
        );
    } else {
        content = props.state.records.map((record) => {
            const rowIdentity = pluginInvocationLogRowIdentity(record);
            return (
                <Item
                    key={rowIdentity}
                    testID={`${testIDPrefix}.record.${rowIdentity}`}
                    title={record.message ?? t('settingsPlugins.invocationLogs.noMessage')}
                    subtitle={describeLogRecord(record)}
                    detail={record.context.correlationId}
                    mode="info"
                    showChevron={false}
                />
            );
        });
    }

    return (
        <ItemGroup
            title={t('settingsPlugins.invocationLogs.title')}
            footer={t('settingsPlugins.invocationLogs.footer')}
        >
            {props.targetPresentation ? (
                <Item
                    testID={`${testIDPrefix}.target`}
                    title={props.targetPresentation.title}
                    subtitle={props.targetPresentation.subtitle}
                    detail={props.targetPresentation.detail}
                    selected={props.targetPresentation.selected}
                    mode="info"
                    showChevron={false}
                />
            ) : null}
            <Item
                testID={`${testIDPrefix}.correlationFilter`}
                title={t('settingsPlugins.invocationLogs.correlationFilter')}
                subtitle={correlationId || t('settingsPlugins.invocationLogs.correlationFilterAll')}
                onPress={props.onEditCorrelationId}
                disabled={!canRead || isReading || props.state.following}
            />
            <Item
                testID={`${testIDPrefix}.refresh`}
                title={t('settingsPlugins.invocationLogs.refresh')}
                onPress={props.onRefresh}
                loading={isReading && !props.state.following}
                disabled={!canRead || props.state.following}
                showChevron={false}
            />
            {props.state.following ? (
                <Item
                    testID={`${testIDPrefix}.stopFollowing`}
                    title={t('settingsPlugins.invocationLogs.stopFollowing')}
                    onPress={props.onStopFollowing}
                    showChevron={false}
                />
            ) : (
                <Item
                    testID={`${testIDPrefix}.follow`}
                    title={t('settingsPlugins.invocationLogs.follow')}
                    onPress={props.onStartFollowing}
                    disabled={!canRead || isReading}
                    showChevron={false}
                />
            )}
            {canRead && props.state.hasMore && !props.state.following ? (
                <Item
                    testID={`${testIDPrefix}.loadMore`}
                    title={t('settingsPlugins.invocationLogs.loadMore')}
                    onPress={props.onLoadMore}
                    disabled={isReading}
                    showChevron={false}
                />
            ) : null}
            {errorNotice}
            {content}
        </ItemGroup>
    );
}

/**
 * Reads the screen-owned selected plugin machine through the canonical daemon
 * log owner. It consumes one exact selection controller and adds no retained
 * log data or competing target authority.
 */
export function PluginDetailInvocationLogsSection(props: Readonly<{
    pluginId: string;
    selection: PluginMachineExecutionOriginSelectionV1;
}>) {
    const selection = props.selection;
    const targetStatus = resolveTargetStatus(selection);
    const targetPresentation = React.useMemo(
        () => resolvePluginMachineExecutionOriginPresentation(selection),
        [selection],
    );
    const targetKey = React.useMemo(() => exactOriginKey(selection), [selection]);
    const resolveTarget = React.useCallback((): PluginInvocationLogMachineReadTarget | null => {
        const fresh = selection.resolveExecutionOrigin();
        if (!fresh) return null;
        return {
            serverId: fresh.machineTarget.serverId,
            serverIdentityId: fresh.machineTarget.target.serverIdentityId,
            machineId: fresh.machineTarget.target.machineId,
        };
    }, [selection]);
    const controller = usePluginInvocationLogsController({
        pluginId: props.pluginId,
        targetKey,
        resolveTarget,
        read: readPluginInvocationLogsOnMachine,
    });
    const editCorrelationId = React.useCallback(async () => {
        const next = await Modal.prompt(
            t('settingsPlugins.invocationLogs.correlationPromptTitle'),
            t('settingsPlugins.invocationLogs.correlationPromptBody'),
            {
                defaultValue: controller.state.correlationId,
                placeholder: t('settingsPlugins.invocationLogs.correlationPromptPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (next !== null) controller.setCorrelationId(next);
    }, [controller]);

    return (
        <PluginDetailInvocationLogsSectionView
            pluginId={props.pluginId}
            targetStatus={targetStatus}
            targetPresentation={targetPresentation}
            state={controller.state}
            onEditCorrelationId={() => { void editCorrelationId(); }}
            onRefresh={() => { void controller.refresh(); }}
            onLoadMore={() => { void controller.loadMore(); }}
            onStartFollowing={() => { void controller.startFollowing(); }}
            onStopFollowing={controller.stopFollowing}
        />
    );
}

/**
 * Account-retained recovery deliberately has no machine selection or daemon
 * read authority. Keep that visible rather than omitting the logs surface.
 */
export function PluginDetailInvocationLogsUnavailableSection(props: Readonly<{ pluginId: string }>) {
    return (
        <PluginDetailInvocationLogsSectionView
            pluginId={props.pluginId}
            targetStatus="unavailable"
            state={UNAVAILABLE_PLUGIN_INVOCATION_LOGS_STATE}
            onEditCorrelationId={noOp}
            onRefresh={noOp}
            onLoadMore={noOp}
            onStartFollowing={noOp}
            onStopFollowing={noOp}
        />
    );
}
