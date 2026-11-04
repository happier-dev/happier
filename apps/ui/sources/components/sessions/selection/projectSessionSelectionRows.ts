import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListOrderingRules';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { readSessionImageInputAvailability } from '@/sync/domains/session/media/sessionImageInputAvailability';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { storage } from '@/sync/domains/state/storageStore';
import { readSessionWorkStateGroupV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { t } from '@/text';

export type SessionSelectionCandidate = (Session | SessionListRenderableSession) & Readonly<{ serverId: string }>;
/** Presentation only: no metadata, transcript or Machine inventory crosses a window bridge. */
export type SessionSelectionRow = Readonly<{
    id: string;
    address: SessionAddress;
    label: string;
    subtitle: string;
    agentId: string;
    machineId: string | null;
    /** The Machine's name, for a line that speaks about reachability; the subtitle may be a path. */
    machineName: string | null;
    /** Project and Machine in short, for a row that has one line for everything. */
    place: string;
    working: boolean;
    statusText: string;
    statusTone: 'danger' | 'attention' | 'neutral';
    activityLabel: string;
    disabledReason?: string;
    group?: 'focused' | 'recent';
}>;

export function projectSessionSelectionRows(
    sessions: readonly SessionSelectionCandidate[],
    options: Readonly<{ includeServerName?: boolean; nowMs?: number; requireImageInput?: boolean }> = {},
): readonly SessionSelectionRow[] {
    const nowMs = options.nowMs ?? Date.now();
    const includeServerName = options.includeServerName ?? new Set(sessions.map(session => session.serverId)).size > 1;
    return sessions.map(session => {
        const address = { serverId: session.serverId, sessionId: session.id };
        const status = getSessionStatus(session, nowMs);
        const activityAt = readSessionListMeaningfulActivityAt(session);
        const agentId = readSessionRowPresentationAgentId(session) ?? '';
        const imageInput = options.requireImageInput ? readSessionImageInputAvailability(session) : null;
        const machineId = session.metadata?.machineId?.trim() || null;
        const machine = machineId ? storage.getState().machines[machineId] : undefined;
        const machineName = (machine ? getSettledMachineDisplayName(machine) : null) ?? null;
        const where = getSessionSubtitle(session);
        return {
            id: sessionAddressKey(address), address, label: getSessionName(session),
            subtitle: includeServerName
                ? [getServerProfileById(session.serverId)?.name ?? session.serverId, where].filter(Boolean).join(' · ')
                : where,
            agentId,
            machineId,
            machineName,
            place: machineName && machineName !== where
                ? `${where.split(/[\\/]/).filter(Boolean).pop() ?? where} · ${machineName}` : where,
            working: readSessionWorkStateGroupV1(status.bucket) === 'working',
            statusText: status.statusText,
            statusTone: status.tone === 'danger' ? 'danger' : status.tone === 'attention' ? 'attention' : 'neutral',
            activityLabel: activityAt > 0 ? formatShortRelativeTimeAt(activityAt, nowMs) : '',
            ...(imageInput?.available === false ? { disabledReason: t('common.imageInputUnsupported', { agent: resolveAgentCatalogTitle(agentId) }) } : {}),
        };
    });
}
