import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { resolveSessionListRowStoreScopeKey } from '@/components/sessions/shell/row/sessionListVisibleRowStoreScopes';
import { EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 } from '@happier-dev/protocol/sessions/external/statusDemandV1';

import type { ExternalSessionStatusDemandViewportEntry } from './externalSessionStatusDemandCoordinator';

export function collectExternalSessionStatusDemandViewportEntries(params: Readonly<{
    activeServerId: string;
    renderedListItems: ReadonlyArray<SessionListIndexItem>;
    resolveRowRenderable: (rowKey: string) => SessionListRenderableSession | null;
    visibleRowKeys: ReadonlySet<string> | null;
}>): ExternalSessionStatusDemandViewportEntry[] {
    const entries: ExternalSessionStatusDemandViewportEntry[] = [];
    const appendRow = (
        rowKey: string,
        sessionId: string,
        serverIdRaw: string | null | undefined,
        demand: ExternalSessionStatusDemandViewportEntry['demand'],
    ): void => {
        const external = readExternalSessionLink(
            params.resolveRowRenderable(rowKey)?.metadata,
        );
        if (
            !external
            || typeof external.linkedAtMs !== 'number'
            || !Number.isFinite(external.linkedAtMs)
        ) {
            return;
        }
        const serverId = String(serverIdRaw ?? params.activeServerId).trim();
        if (!serverId) return;
        entries.push({
            serverId,
            sessionId,
            machineId: external.machineId,
            linkGeneration: String(external.linkedAtMs),
            demand,
        });
    };

    if (params.visibleRowKeys !== null) {
        // `renderedListItems` is already the exact viewport subset in this mode.
        // Row keys are opaque canonical Session-address keys, so never parse them.
        for (const item of params.renderedListItems) {
            if (entries.length >= EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1) break;
            if (item.type !== 'session') continue;
            const rowKey = resolveSessionListRowStoreScopeKey({
                sessionId: item.sessionId,
                serverId: item.serverId ?? null,
            });
            if (!params.visibleRowKeys.has(rowKey)) continue;
            appendRow(rowKey, item.sessionId, item.serverId, 'visible');
        }
        return entries;
    }

    let inspectedSessionRows = 0;
    for (const item of params.renderedListItems) {
        if (item.type !== 'session') continue;
        if (inspectedSessionRows >= EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1) break;
        inspectedSessionRows += 1;
        const rowKey = resolveSessionListRowStoreScopeKey({
            sessionId: item.sessionId,
            serverId: item.serverId ?? null,
        });
        appendRow(rowKey, item.sessionId, item.serverId, 'loaded');
    }
    return entries;
}
