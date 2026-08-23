import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { BrowserLaunchpadRow, BrowserLaunchpadSection } from '@/sync/domains/browser/targets';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { selectBrowserTargetAdapter } from '@/sync/domains/browser/adapters/selection';
import { resolveExternalUrlTargetFromInput } from '@/sync/domains/browser/shell';
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

import { BrowserUrlField } from '../BrowserUrlField';
import { BrowserTargetCard } from './BrowserTargetCard';

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
    list: {
        backgroundColor: theme.colors.surface.base,
    },
    listContent: {
        paddingBottom: 16,
    },
    urlEntry: {
        marginHorizontal: 16,
        marginTop: 12,
    },
    banner: {
        marginHorizontal: 16,
        marginTop: 12,
    },
    terminalState: {
        // The card owns its own centring; this only gives it something to centre inside when the
        // list is otherwise empty.
        minHeight: 240,
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
    /**
     * Fires the instant a row is committed, with the row's horizontal centre in shell coordinates.
     * The shell uses it to hand the launchpad off to the load-progress sweep so the page does not
     * simply cut in. Purely presentational; navigation still goes through the seams above.
     */
    onRowHandoff?: (input: Readonly<{ rowId: string; originX: number | null }>) => void;
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
    const handleOpenTarget = React.useCallback((row: ResolvedBrowserLaunchpadRow, originX: number | null) => {
        if (!row.target || row.disabledReason) {
            return;
        }
        const open = row.launchMode === 'currentView'
            ? props.onNavigateInPlace
            : props.onOpenTarget;
        if (row.launchMode === 'currentView') {
            props.onRowHandoff?.({ rowId: row.id, originX });
        }
        open?.(row.target, {
            platform: props.platform,
            ...(row.currentUrl ? { currentUrl: row.currentUrl } : {}),
            ...(typeof row.currentUrlExpiresAt === 'number' ? { currentUrlExpiresAt: row.currentUrlExpiresAt } : {}),
            ...(row.targetPolicyDecision ? { targetPolicyDecision: row.targetPolicyDecision } : {}),
            ...(row.desktopWebViewAvailability ? { desktopWebViewAvailability: row.desktopWebViewAvailability } : {}),
        });
    }, [props.onNavigateInPlace, props.onOpenTarget, props.onRowHandoff, props.platform]);

    // The URL entry submits a normalized http(s) URL; turning it into a target is the launchpad's
    // job because the seam it delegates to is target-shaped. One normalizer, one target builder.
    const handleSubmitUrl = React.useCallback((url: string) => {
        const target = resolveExternalUrlTargetFromInput(url);
        if (!target) return;
        // Navigate the CURRENT tab in place (turn the new-tab page INTO the page) — never a sibling tab.
        props.onNavigateInPlace?.(target, { platform: props.platform });
    }, [props.onNavigateInPlace, props.platform]);

    const hasRows = resolvedRows.length > 0;

    return (
        <ItemList
            testID={testID}
            style={stylesheet.list}
            containerStyle={stylesheet.listContent}
            keyboardShouldPersistTaps="handled"
        >
            <View style={stylesheet.urlEntry}>
                <BrowserUrlField
                    testID={`${testID}-url-entry`}
                    density="panel"
                    trailingAction="go"
                    clearOnSubmit
                    value=""
                    disabled={!props.onNavigateInPlace}
                    label={t('browserLaunchpad.urlEntry.label')}
                    placeholder={t('browserLaunchpad.urlEntry.placeholder')}
                    accessibilityLabel={t('browserLaunchpad.urlEntry.label')}
                    onSubmitUrl={handleSubmitUrl}
                />
            </View>

            {!hasRows ? (
                <View style={stylesheet.terminalState}>
                    {props.refreshStatus === 'refreshing' ? (
                        <SurfaceStateCard
                            testID={`${testID}-refreshing`}
                            kind="loading"
                            title={t('browserLaunchpad.refreshing')}
                            accessibilitySemantics="status"
                        />
                    ) : props.refreshStatus === 'error' ? (
                        <SurfaceStateCard
                            testID={`${testID}-error`}
                            kind="error"
                            title={t('browserLaunchpad.error.title')}
                            {...(props.refreshError
                                ? { reason: t('browserLaunchpad.error.subtitle', { reason: props.refreshError }) }
                                : {})}
                            accessibilitySemantics="alert"
                        />
                    ) : (
                        <SurfaceStateCard
                            testID={`${testID}-guidance`}
                            kind="empty"
                            iconName="globe"
                            title={t('browserLaunchpad.guidance.title')}
                            reason={t('browserLaunchpad.guidance.body')}
                        />
                    )}
                </View>
            ) : (
                <>
                    {props.refreshStatus !== 'idle' ? (
                        <View style={stylesheet.banner}>
                            <ItemGroup>
                                <BrowserLaunchpadRefreshBanner
                                    testID={testID}
                                    status={props.refreshStatus}
                                    refreshError={props.refreshError ?? null}
                                />
                            </ItemGroup>
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
                                {rows.map((row, index) => (
                                    <BrowserTargetCard
                                        key={row.id}
                                        row={row}
                                        entranceIndex={index}
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
                </>
            )}
        </ItemList>
    );
}

/**
 * The refresh state WHILE rows are already on screen. It is an informational banner rather than a
 * {@link SurfaceStateCard} on purpose: the pane is not in a terminal state, and replacing live rows
 * with a card would flash away hydrated content the user is reading (`apps/ui/AGENTS.md`
 * "Preserve last-known-good UI during refresh").
 */
function BrowserLaunchpadRefreshBanner(props: Readonly<{
    testID: string;
    status: 'refreshing' | 'error';
    refreshError: string | null;
}>): React.ReactElement {
    if (props.status === 'refreshing') {
        return (
            <Item
                testID={`${props.testID}-refreshing`}
                title={t('browserLaunchpad.refreshing')}
                mode="info"
                showChevron={false}
            />
        );
    }
    return (
        <Item
            testID={`${props.testID}-error`}
            title={t('browserLaunchpad.error.title')}
            subtitle={props.refreshError ? t('browserLaunchpad.error.subtitle', { reason: props.refreshError }) : undefined}
            mode="info"
            showChevron={false}
        />
    );
}
