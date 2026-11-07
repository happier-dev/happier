import type { DestinationInstanceTitleEntry } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { DocumentTabPresentation } from '@/components/ui/navigation/DocumentTabStrip';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { sessionListRuntimeClock, useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { storage } from '@/sync/domains/state/storageStore';
import { getSessionStatus, readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { readSessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

/** Tab chrome consumes the same Home-scoped summary and awareness answer as Session rows. */
export function useDestinationInstanceTabPresentations(entries: readonly DestinationInstanceTitleEntry[]): ReadonlyMap<string, DocumentTabPresentation> {
    const sessionEntries = React.useMemo(() => entries.filter((entry) => entry.ref.kind === 'session'), [entries]);
    const activeServer = useActiveServerSnapshot(sessionEntries.some((entry) => !entry.ref.params.serverId));
    // Only this strip's freshness boundary consumes time; another date leaf's wake does not.
    const wakeToken = React.useRef({}).current;
    const nowMs = useSessionListRuntimeNowMs(sessionEntries.length > 0, sessionListRuntimeClock, wakeToken);
    // Select the tab chrome itself, not the rows: every message or agent-state write replaces an open
    // tab's row, and the strip must redraw only when a tab's status or its freshness deadline changes.
    // The selector runs on every storage publish; a tab whose row and time are unchanged reuses its
    // answer, so unrelated publishes (navigation, settings) derive nothing.
    const derived = React.useRef(new Map<string, Readonly<{ row: object; nowMs: number; selected: string }>>()).current;
    const statuses = storage(useShallow((state) => {
        const selected: Record<string, string> = {};
        for (const entry of sessionEntries) {
            const row = readSessionListRowForServerId(
                state.sessionListRowsByServerId,
                entry.ref.params.serverId || activeServer.serverId,
                entry.ref.params.id,
            );
            if (!row) continue;
            const held = derived.get(entry.key);
            if (held && held.row === row && held.nowMs === nowMs) {
                selected[entry.key] = held.selected;
                continue;
            }
            const status = resolveTabStatus(row, nowMs);
            const refreshAtMs = readSessionStatusNextRefreshAtMs(row, nowMs);
            // A Bot's tab leads with its face (Living Bots lab), read from the row this tab already holds.
            const face = readSessionBotFaceFacts(row, entry.ref.params.serverId || activeServer.serverId);
            const faceKey = face ? JSON.stringify([face.seed, face.face]) : '';
            const value = `${status?.tone ?? ''}\u0000${status?.label ?? ''}\u0000${refreshAtMs ?? ''}\u0000${faceKey}`;
            derived.set(entry.key, { row, nowMs, selected: value });
            selected[entry.key] = value;
        }
        // A closed tab's answer leaves with it.
        if (derived.size > sessionEntries.length) for (const key of derived.keys()) if (!(key in selected)) derived.delete(key);
        return selected;
    }));
    const previous = React.useRef<ReadonlyMap<string, DocumentTabPresentation>>(new Map());
    const marks = React.useRef(new Map<string, Readonly<{ faceKey: string; mark: React.ReactElement }>>()).current;
    const projection = React.useMemo(() => {
        let nextWakeAtMs: number | null = null;
        const presentations = new Map<string, DocumentTabPresentation>();
        for (const [key, selected] of Object.entries(statuses)) {
            const [tone, label, refreshAt, faceKey] = selected.split('\u0000');
            if (refreshAt) nextWakeAtMs = nextWakeAtMs === null ? Number(refreshAt) : Math.min(nextWakeAtMs, Number(refreshAt));
            const mark = faceKey ? resolveTabFaceMark(marks, key, faceKey) : undefined;
            if (!faceKey) marks.delete(key);
            if (tone || mark) presentations.set(key, {
                ...(tone ? { status: { tone: tone as TabStatusTone, label: label ?? '' } } : {}),
                ...(mark ? { mark } : {}),
            });
        }
        for (const key of marks.keys()) if (!(key in statuses)) marks.delete(key);
        // Keep unchanged published chrome stable when only a freshness deadline moved.
        if (previous.current.size !== presentations.size || [...presentations].some(([key, value]) => {
            const old = previous.current.get(key);
            return old?.status?.tone !== value.status?.tone || old?.status?.label !== value.status?.label || old?.mark !== value.mark;
        })) previous.current = presentations;
        return { presentations: previous.current, nextWakeAtMs };
    }, [statuses]);
    useSessionListRuntimeWake(projection.nextWakeAtMs, sessionEntries.length > 0, sessionListRuntimeClock, wakeToken);
    return projection.presentations;
}

type TabStatusTone = NonNullable<DocumentTabPresentation['status']>['tone'];

/** One face element per tab, reused until that Bot's seed or saved face changes. */
function resolveTabFaceMark(
    marks: Map<string, Readonly<{ faceKey: string; mark: React.ReactElement }>>,
    key: string,
    faceKey: string,
): React.ReactElement {
    const held = marks.get(key);
    if (held?.faceKey === faceKey) return held.mark;
    const [seed, face] = JSON.parse(faceKey) as [string, SessionBotFaceV1 | null];
    const mark = React.createElement(SessionBotFace, { facts: { seed, face }, size: M.tabGlyphPx });
    marks.set(key, { faceKey, mark });
    return mark;
}

function resolveTabStatus(row: Parameters<typeof getSessionStatus>[0], nowMs: number): Readonly<{ tone: TabStatusTone; label: string }> | null {
    const presentation = getSessionStatus(row, nowMs, { includeTitle: false, disconnectedTextMode: 'offline' });
    if (presentation.tone === 'danger') return { tone: 'failed', label: presentation.statusText };
    if (presentation.tone === 'attention') return { tone: 'attention', label: presentation.statusText };
    if (presentation.bucket === 'working') return { tone: 'working', label: presentation.statusText };
    if (presentation.bucket === 'offline') return { tone: 'offline', label: presentation.statusText };
    return null;
}
