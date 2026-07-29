import {
    BrowserTargetDisplayV1Schema,
    BrowserViewTargetV1Schema,
    type BrowserViewTargetV1,
    type LocalServiceLauncherSnapshotV1,
    type LocalServiceLaunchTargetV1,
} from '@happier-dev/protocol';

import { resolvePluginBrowserPolicyDecision } from '@/sync/domains/plugins/browser/policy';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type {
    PluginBrowserProjectionModel,
    PluginBrowserTargetProjection,
} from '@/sync/domains/plugins/browser/targets';
import {
    selectLocalServicePreviewRows,
    type LocalServicePreviewRow,
    type LocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';

import type { BrowserRecentTarget } from './recents';

export type BrowserLaunchpadSection = 'running' | 'managed' | 'plugin' | 'recent' | 'unavailable';

export type BrowserLaunchpadRowSourceKind = 'localService' | 'hostedPluginWeb' | 'pluginExternalUrl' | 'recent';

export type BrowserLaunchpadRow = Readonly<{
    id: string;
    section: BrowserLaunchpadSection;
    sourceKind: BrowserLaunchpadRowSourceKind;
    title: string;
    subtitle?: string;
    detail: string;
    target: BrowserViewTargetV1 | null;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
    launchMode?: 'newView' | 'currentView';
    profileMode?: 'ephemeral' | 'session' | 'user' | 'plugin';
    disabledReason: string | null;
    lastSeenAt: number;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

const SECTION_WEIGHT: Readonly<Record<BrowserLaunchpadSection, number>> = {
    running: 0,
    managed: 1,
    plugin: 2,
    recent: 3,
    unavailable: 4,
};

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readHttpEndpointUrl(entry: UnknownRecord): string | null {
    const endpointUrl = readString(entry.endpointUrl)
        ?? readString(asRecord(entry.endpoint)?.url)
        ?? readString(asRecord(entry.runtime)?.endpointUrl);
    if (!endpointUrl) {
        return null;
    }
    try {
        const parsed = new URL(endpointUrl);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function readEndpointExpiresAt(entry: UnknownRecord): number | null {
    const value = entry.endpointExpiresAt
        ?? asRecord(entry.endpoint)?.expiresAt
        ?? asRecord(entry.runtime)?.endpointExpiresAt;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseTarget(value: unknown): BrowserViewTargetV1 | null {
    const result = BrowserViewTargetV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function readDisplay(value: unknown): Readonly<{
    title: string;
    subtitle?: string;
}> | null {
    const parsed = BrowserTargetDisplayV1Schema.safeParse(value);
    if (parsed.success) {
        return {
            title: parsed.data.title,
            subtitle: parsed.data.addressLabel,
        };
    }
    const record = asRecord(value);
    const title = readString(record?.title);
    if (!title) {
        return null;
    }
    return {
        title,
        subtitle: readString(record?.addressLabel) ?? undefined,
    };
}

function sectionForLaunchTarget(target: LocalServiceLaunchTargetV1): BrowserLaunchpadSection {
    if (target.state !== 'available') {
        return 'unavailable';
    }
    return target.source === 'managed_service' ? 'managed' : 'running';
}

function disabledReasonForLaunchTarget(target: LocalServiceLaunchTargetV1): string | null {
    if (target.state !== 'available') {
        return target.unavailableReason ?? target.state;
    }
    if (!target.browserTarget) {
        return 'browser_target_unavailable';
    }
    return null;
}

function rowFromLaunchTarget(
    target: LocalServiceLaunchTargetV1,
    lastSeenAt: number,
): BrowserLaunchpadRow {
    return {
        id: `localService:${target.id}`,
        section: sectionForLaunchTarget(target),
        sourceKind: 'localService',
        title: target.title,
        subtitle: target.subtitle,
        detail: target.kind ?? target.source,
        target: target.browserTarget ?? null,
        disabledReason: disabledReasonForLaunchTarget(target),
        lastSeenAt,
    };
}

function rowFromLocalServicePreview(
    row: LocalServicePreviewRow,
    nowMs: number,
    lastSeenAt: number,
): BrowserLaunchpadRow {
    const target: BrowserViewTargetV1 = row.resource.browserTarget ?? {
        kind: 'localServicePreview',
        targetId: row.previewId,
        sessionId: row.resource.sessionId,
        machineId: row.resource.machineId,
        display: {
            title: row.resource.display.title,
            addressLabel: row.resource.display.addressLabel,
            ...(row.resource.display.folderLabel ? { folderLabel: row.resource.display.folderLabel } : {}),
            ...(row.resource.display.iconToken ? { iconToken: row.resource.display.iconToken } : {}),
            ...(row.resource.display.tone ? { tone: row.resource.display.tone } : {}),
        },
    };
    const endpointExpired = typeof row.expiresAt === 'number' && row.expiresAt <= nowMs;
    const disabledReason = !row.accessUrl
        ? 'local_preview_url_unavailable'
        : endpointExpired
            ? 'local_preview_url_expired'
            : null;
    return {
        id: `localServicePreview:${row.previewId}`,
        section: disabledReason ? 'unavailable' : 'running',
        sourceKind: 'localService',
        title: row.resource.display.title,
        subtitle: row.resource.display.addressLabel,
        detail: 'registered_preview',
        target,
        ...(disabledReason === null && row.accessUrl ? { currentUrl: row.accessUrl } : {}),
        ...(disabledReason === null && typeof row.expiresAt === 'number' ? { currentUrlExpiresAt: row.expiresAt } : {}),
        disabledReason,
        lastSeenAt,
    };
}

function rowFromPluginTarget(
    entry: PluginBrowserTargetProjection,
    nowMs: number,
    policyContext?: PluginUiPolicyEvaluationContext,
): BrowserLaunchpadRow | null {
    const policyDecision = resolvePluginBrowserPolicyDecision(entry, policyContext);
    if (!policyDecision.visible) {
        return null;
    }
    const target = parseTarget(entry.target);
    const display = readDisplay(entry.display);
    if (!target || !display) {
        return null;
    }
    if (target.kind === 'externalUrl') {
        const launchMode = entry.launchMode;
        const profileMode = entry.profileMode;
        if (
            (launchMode !== 'newView' && launchMode !== 'currentView')
            || (profileMode !== 'ephemeral' && profileMode !== 'session' && profileMode !== 'user' && profileMode !== 'plugin')
        ) {
            return null;
        }
        return {
            id: `pluginExternalUrl:${entry.id}`,
            section: policyDecision.enabled ? 'plugin' : 'unavailable',
            sourceKind: 'pluginExternalUrl',
            title: display.title,
            subtitle: display.subtitle,
            detail: entry.pluginId,
            target,
            currentUrl: target.url,
            launchMode,
            profileMode,
            disabledReason: policyDecision.unavailableReason,
            lastSeenAt: 0,
        };
    }
    if (target.kind !== 'hostedPluginWeb') {
        return null;
    }
    const endpointUrl = readHttpEndpointUrl(entry);
    const endpointExpiresAt = readEndpointExpiresAt(entry);
    const endpointExpired = typeof endpointExpiresAt === 'number' && endpointExpiresAt <= nowMs;
    const disabledReason = !endpointUrl
        ? 'hosted_plugin_endpoint_unavailable'
        : endpointExpired
            ? 'hosted_plugin_endpoint_expired'
            : null;
    const currentUrl = disabledReason === null ? endpointUrl : undefined;
    const currentUrlExpiresAt = disabledReason === null && typeof endpointExpiresAt === 'number'
        ? endpointExpiresAt
        : undefined;
    return {
        id: `pluginHostedWeb:${entry.id}`,
        section: 'plugin',
        sourceKind: 'hostedPluginWeb',
        title: display.title,
        subtitle: display.subtitle,
        detail: entry.pluginId,
        target,
        ...(currentUrl ? { currentUrl } : {}),
        ...(typeof currentUrlExpiresAt === 'number' ? { currentUrlExpiresAt } : {}),
        disabledReason,
        // B-RC6: derive `lastSeenAt` from a STABLE per-entry source (the endpoint's own expiry), never
        // `nowMs` — folding the poll clock into row identity churned the sort key every poll and made
        // the launchpad flicker. `nowMs` is used ONLY for expiry comparison above, never for identity.
        lastSeenAt: typeof endpointExpiresAt === 'number' ? endpointExpiresAt : 0,
    };
}

function rowFromRecent(entry: BrowserRecentTarget): BrowserLaunchpadRow {
    return {
        id: `recent:${entry.target.targetId}`,
        section: 'recent',
        sourceKind: 'recent',
        title: entry.target.display?.title ?? entry.target.targetId,
        subtitle: entry.target.display?.addressLabel,
        detail: entry.target.kind,
        target: entry.target,
        disabledReason: null,
        lastSeenAt: entry.openedAt,
    };
}

function rankRows(a: BrowserLaunchpadRow, b: BrowserLaunchpadRow): number {
    const sectionDelta = SECTION_WEIGHT[a.section] - SECTION_WEIGHT[b.section];
    if (sectionDelta !== 0) {
        return sectionDelta;
    }
    const seenDelta = b.lastSeenAt - a.lastSeenAt;
    if (seenDelta !== 0) {
        return seenDelta;
    }
    return a.title.localeCompare(b.title);
}

function dedupeRows(rows: readonly BrowserLaunchpadRow[]): readonly BrowserLaunchpadRow[] {
    const seenTargets = new Set<string>();
    const output: BrowserLaunchpadRow[] = [];
    for (const row of rows) {
        const targetKey = row.target ? `${row.target.kind}:${row.target.targetId}` : row.id;
        if (seenTargets.has(targetKey)) {
            continue;
        }
        seenTargets.add(targetKey);
        output.push(row);
    }
    return output;
}

export function buildBrowserLaunchpadRows(input: Readonly<{
    launcherSnapshot?: LocalServiceLauncherSnapshotV1 | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserPolicyContext?: PluginUiPolicyEvaluationContext;
    recents?: readonly BrowserRecentTarget[];
    nowMs?: number;
}>): readonly BrowserLaunchpadRow[] {
    const nowMs = input.nowMs ?? Date.now();
    const localPreviewRows = (input.localServicePreviewState
        ? selectLocalServicePreviewRows(input.localServicePreviewState)
        : []
    ).map((row) => rowFromLocalServicePreview(
        row,
        nowMs,
        input.localServicePreviewState?.generatedAt ?? nowMs,
    ));
    const launcherRows = (input.launcherSnapshot?.targets ?? [])
        .map((target) => rowFromLaunchTarget(target, input.launcherSnapshot?.updatedAt ?? nowMs));
    const pluginRows = Object.values(input.pluginBrowserProjection?.targetsById ?? {})
        .map((entry) => rowFromPluginTarget(entry, nowMs, input.pluginBrowserPolicyContext))
        .filter((row): row is BrowserLaunchpadRow => Boolean(row));
    const recentRows = (input.recents ?? []).map(rowFromRecent);
    return dedupeRows([...localPreviewRows, ...launcherRows, ...pluginRows, ...recentRows].sort(rankRows));
}
