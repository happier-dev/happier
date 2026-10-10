import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import type { PluginReadOnlySnapshotReason } from './model/pluginMarketplaceModel';

function resolveNoticeSubtitle(reason: Exclude<PluginReadOnlySnapshotReason, 'refreshing'>): string {
    if (reason === 'installationUnavailable') {
        return t('settingsPlugins.installationReadUnavailable');
    }
    if (reason === 'projectionUnavailable') {
        return t('settingsPlugins.surfaces.projectionFailedBody');
    }
    if (reason === 'accountRecovery') {
        return t('settingsPlugins.readOnlyAccountRecovery');
    }
    return t('settingsPlugins.surfaces.machineOfflineBody');
}

function resolveNoticeTitle(reason: Exclude<PluginReadOnlySnapshotReason, 'refreshing'>): string {
    if (reason === 'projectionUnavailable') return t('settingsPlugins.surfaces.projectionFailedTitle');
    if (reason === 'installationUnavailable') return t('settingsPlugins.surfaces.readFailedTitle');
    if (reason === 'accountRecovery') return t('settingsPlugins.detailMissingTitle');
    return t('settingsPlugins.surfaces.machineOfflineTitle');
}

/**
 * The plugin page's read-only notice: the plugin copy for why the list is read-only, shown through the
 * one tinted page notice (`AttentionBanner`) with Retry as its action when a failed read can be retried.
 */
export const PluginReadOnlySnapshotNotice = React.memo(function PluginReadOnlySnapshotNotice(props: Readonly<{
    testID: string;
    reason: PluginReadOnlySnapshotReason;
    onRetry?: () => void;
}>) {
    // Retained content is already visible. Routine refresh is not a warning or a second
    // whole-surface loading state; failed reads below retain their recovery action.
    if (props.reason === 'refreshing') return null;
    // Only failed reads from a reachable machine can be retried here.
    const onRetry = props.reason === 'projectionUnavailable' || props.reason === 'installationUnavailable' ? props.onRetry : undefined;
    return (
        <AttentionBanner
            testID={props.testID}
            tone="warning"
            title={resolveNoticeTitle(props.reason)}
            description={resolveNoticeSubtitle(props.reason)}
            accessibilityLiveRegion="polite"
            action={onRetry ? { label: t('common.retry'), onPress: onRetry, testID: `${props.testID}-retry` } : null}
        />
    );
});
