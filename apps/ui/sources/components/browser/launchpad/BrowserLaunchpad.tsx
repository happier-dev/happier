import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import type { BrowserLaunchpadRow, BrowserLaunchpadSection } from '@/sync/domains/browser/targets';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { selectBrowserTargetAdapter } from '@/sync/domains/browser/adapters/selection';
import type {
    BrowserPlatformV1,
    BrowserProfileV1,
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
    FeatureDecision,
} from '@happier-dev/protocol';
import {
    evaluateBrowserTargetPolicy,
    resolveHostedPluginBrowserPolicyUnavailableReason,
} from '@/sync/domains/browser/policy/evaluate';
import { t } from '@/text';

import { BrowserTargetCard } from './BrowserTargetCard';
import { BrowserLaunchpadUrlEntry } from './BrowserLaunchpadUrlEntry';

export type BrowserLaunchpadOpenTargetOptions = Readonly<{
    platform: BrowserPlatformV1;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>;

type ResolvedBrowserLaunchpadRow = BrowserLaunchpadRow & Readonly<{
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>;

const SECTION_ORDER: readonly BrowserLaunchpadSection[] = [
    'running',
    'managed',
    'plugin',
    'recent',
    'unavailable',
];

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
        paddingBottom: 16,
    },
    banner: {
        marginHorizontal: 16,
        marginTop: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        overflow: 'hidden',
    },
    guidance: {
        marginHorizontal: 16,
        marginTop: 16,
        gap: 4,
    },
    guidanceTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    guidanceBody: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));

function titleForSection(section: BrowserLaunchpadSection): string {
    switch (section) {
        case 'running':
            return t('browserLaunchpad.sections.running');
        case 'managed':
            return t('browserLaunchpad.sections.managed');
        case 'plugin':
            return t('browserLaunchpad.sections.plugin');
        case 'recent':
            return t('browserLaunchpad.sections.recent');
        case 'unavailable':
            return t('browserLaunchpad.sections.unavailable');
    }
}

function rowsBySection(rows: readonly ResolvedBrowserLaunchpadRow[]): ReadonlyMap<BrowserLaunchpadSection, readonly ResolvedBrowserLaunchpadRow[]> {
    const grouped = new Map<BrowserLaunchpadSection, ResolvedBrowserLaunchpadRow[]>();
    for (const row of rows) {
        const group = grouped.get(row.section) ?? [];
        group.push(row);
        grouped.set(row.section, group);
    }
    return grouped;
}

function resolveLaunchpadRow(
    row: BrowserLaunchpadRow,
    platform: BrowserPlatformV1,
    browserProfile: BrowserProfileV1 | null | undefined,
    browserFeatureDecision: FeatureDecision | null | undefined,
    desktopWebViewAvailability: DesktopWebViewNativeAvailability | null | undefined,
    allowExternalUrlBrowsing: boolean,
): ResolvedBrowserLaunchpadRow {
    if (!row.target || row.disabledReason) {
        return row;
    }
    if (row.profileMode && browserProfile?.storageMode !== row.profileMode) {
        return {
            ...row,
            disabledReason: 'plugin_browser_profile_mode_unavailable',
        };
    }
    if (row.target.kind === 'externalUrl') {
        const targetPolicyDecision = evaluateBrowserTargetPolicy({
            target: row.target,
            profile: browserProfile,
            browserFeatureDecision,
            allowExternalUrlBrowsing,
        });
        if (targetPolicyDecision.state !== 'allowed') {
            return {
                ...row,
                targetPolicyDecision,
                disabledReason: targetPolicyDecision.reasonCode ?? 'external_url_policy_denied',
            };
        }
        const adapter = selectBrowserTargetAdapter({
            target: row.target,
            platform,
            targetPolicyDecision,
            desktopWebViewAvailability,
        });
        return adapter.ok
            ? {
                ...row,
                targetPolicyDecision,
                desktopWebViewAvailability,
            }
            : {
                ...row,
                targetPolicyDecision,
                desktopWebViewAvailability,
                disabledReason: adapter.reasonCode,
            };
    }
    const policyUnavailableReason = resolveHostedPluginBrowserPolicyUnavailableReason({
        target: row.target,
        profile: browserProfile,
    });
    if (policyUnavailableReason) {
        return {
            ...row,
            disabledReason: policyUnavailableReason,
        };
    }
    const adapter = selectBrowserTargetAdapter({
        target: row.target,
        platform,
    });
    return adapter.ok
        ? row
        : {
            ...row,
            disabledReason: adapter.reasonCode,
        };
}

export function BrowserLaunchpad(props: Readonly<{
    rows: readonly BrowserLaunchpadRow[];
    platform: BrowserPlatformV1;
    browserProfile?: BrowserProfileV1 | null;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    refreshStatus: 'idle' | 'refreshing' | 'error';
    refreshError?: string | null;
    onOpenTarget?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    /**
     * OWNER-NAV (DV-NAV): the current-tab in-place navigation seam used by the URL entry box. A
     * launchpad/new-tab URL submit turns THIS tab into the page in place instead of spawning a
     * sibling tab. `onOpenTarget` (new tab) stays reserved for external-surface opens.
     */
    onNavigateInPlace?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-launchpad';
    const resolvedRows = React.useMemo(
        () => props.rows.map((row) => resolveLaunchpadRow(
            row,
            props.platform,
            props.browserProfile,
            props.browserFeatureDecision,
            props.desktopWebViewAvailability,
            props.allowExternalUrlBrowsing ?? true,
        )),
        [
            props.allowExternalUrlBrowsing,
            props.browserFeatureDecision,
            props.browserProfile,
            props.desktopWebViewAvailability,
            props.platform,
            props.rows,
        ],
    );
    const grouped = React.useMemo(() => rowsBySection(resolvedRows), [resolvedRows]);
    const handleOpenTarget = React.useCallback((row: ResolvedBrowserLaunchpadRow) => {
        if (!row.target || row.disabledReason) {
            return;
        }
        const open = row.launchMode === 'currentView'
            ? props.onNavigateInPlace
            : props.onOpenTarget;
        open?.(row.target, {
            platform: props.platform,
            ...(row.currentUrl ? { currentUrl: row.currentUrl } : {}),
            ...(typeof row.currentUrlExpiresAt === 'number' ? { currentUrlExpiresAt: row.currentUrlExpiresAt } : {}),
            ...(row.targetPolicyDecision ? { targetPolicyDecision: row.targetPolicyDecision } : {}),
            ...(row.desktopWebViewAvailability ? { desktopWebViewAvailability: row.desktopWebViewAvailability } : {}),
        });
    }, [props.onNavigateInPlace, props.onOpenTarget, props.platform]);

    const showGuidance = resolvedRows.length === 0 && props.refreshStatus !== 'refreshing';

    return (
        <View testID={testID} style={stylesheet.root}>
            <BrowserLaunchpadUrlEntry
                testID={`${testID}-url-entry`}
                platform={props.platform}
                onNavigateInPlace={props.onNavigateInPlace}
            />
            {props.refreshStatus === 'refreshing' ? (
                <View style={stylesheet.banner}>
                    <Item
                        testID={`${testID}-refreshing`}
                        title={t('browserLaunchpad.refreshing')}
                        mode="info"
                        showChevron={false}
                    />
                </View>
            ) : null}
            {props.refreshStatus === 'error' ? (
                <View style={stylesheet.banner}>
                    <Item
                        testID={`${testID}-error`}
                        title={t('browserLaunchpad.error.title')}
                        subtitle={props.refreshError ? t('browserLaunchpad.error.subtitle', { reason: props.refreshError }) : undefined}
                        mode="info"
                        showChevron={false}
                    />
                </View>
            ) : null}
            {showGuidance ? (
                <View testID={`${testID}-guidance`} style={stylesheet.guidance}>
                    <Text style={stylesheet.guidanceTitle}>{t('browserLaunchpad.guidance.title')}</Text>
                    <Text style={stylesheet.guidanceBody}>{t('browserLaunchpad.guidance.body')}</Text>
                </View>
            ) : null}
            {SECTION_ORDER.map((section) => {
                const rows = grouped.get(section) ?? [];
                if (rows.length === 0) {
                    return null;
                }
                return (
                    <ItemGroup
                        key={section}
                        title={titleForSection(section)}
                        selectableItemCountOverride={rows.length}
                    >
                        {rows.map((row) => (
                            <BrowserTargetCard
                                key={row.id}
                                row={row}
                                testID={`${testID}-card:${row.id}`}
                                onOpenTarget={handleOpenTarget}
                                openDisabled={row.launchMode === 'currentView'
                                    ? !props.onNavigateInPlace
                                    : !props.onOpenTarget}
                            />
                        ))}
                    </ItemGroup>
                );
            })}
        </View>
    );
}
