/**
 * What a switcher row shows, read once when the switcher opens.
 *
 * The bar's gesture lives in chrome mounted on every route, so rows are never subscriptions:
 * one imperative read of the store per open, for exactly the rows the switcher will paint
 * (the same reasoning the old lateral readout recorded). Classification is delegated to the
 * canonical owners — `getSessionName`, `getSessionStatus`, the retained transcript reader and
 * the draft repository — so a row says exactly what the session list says.
 */

import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';

import type { IconName } from '@/components/ui/icons/Icon';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import type { SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import type { SessionSwitcherEntry, SessionSwitcherSection } from '@/sync/domains/session/navigation/sessionSwitcherOrder';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { getExistingSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';

export type SessionSwitcherRowTone = 'working' | 'attention' | 'failed' | 'offline' | 'quiet';

export type SessionSwitcherRowTarget =
    | Readonly<{ kind: 'session'; sessionId: string; serverId: string | null; tabId: string | null }>
    | Readonly<{ kind: 'tab'; tabId: string }>;

export type SessionSwitcherRow = Readonly<{
    key: string;
    section: SessionSwitcherSection;
    target: SessionSwitcherRowTarget;
    title: string;
    /** Session rows: the agent identity the catalog renders (neutral mark when unknown). */
    agentId: string | null;
    machineId: string | null;
    serverId: string | null;
    /** Non-session tab rows: the destination's icon. */
    icon: IconName | null;
    status: Readonly<{ text: string; tone: SessionSwitcherRowTone }> | null;
    timeLabel: string;
    /** The last thing said in the session, when its transcript is retained on this device. */
    excerpt: string | null;
    /** The person's unsent words in the composer. */
    draft: string | null;
    unavailable: boolean;
}>;

/** An open tab that is not a session, as the workspace owner presents it. */
export type SessionSwitcherTabPresentation = Readonly<{
    tabId: string;
    title: string;
    icon: IconName | null;
    unavailable: boolean;
    session: SessionAddress | null;
    /** Where the tab lives, when its title does not say (`usePhoneWorkspaceTabs`). */
    context?: string | null;
}>;

type RowsState = Readonly<{
    sessions?: Readonly<Record<string, unknown>> | null;
    sessionMessages?: Record<string, unknown>;
    sessionListRowsByServerId?: SessionListRowStateByServerId | null;
}>;

type SessionLike = Readonly<{
    id?: string;
    metadata?: unknown;
    metadataLayoutVersion?: number;
    createdAt: number;
    meaningfulActivityAt?: number | null;
    serverId?: unknown;
}>;

/**
 * Session keys are opaque (`sessionAddressKey`: never parse them), so the switcher resolves a key
 * by building keys forward from the addresses this device knows: every session-list row of every
 * Home, plus any extra addresses the caller holds (the current session, the captured list).
 */
export function buildSessionSwitcherAddressIndex(
    state: RowsState,
    extra: readonly SessionAddress[],
): Map<string, SessionAddress> {
    const index = new Map<string, SessionAddress>();
    for (const [serverId, rows] of Object.entries(state.sessionListRowsByServerId ?? {})) {
        for (const sessionId of Object.keys(rows ?? {})) {
            index.set(buildServerScopedSessionKey(sessionId, serverId), { serverId, sessionId });
        }
    }
    for (const address of extra) index.set(buildServerScopedSessionKey(address.sessionId, address.serverId), address);
    return index;
}

function readSession(state: RowsState, address: SessionAddress): SessionLike | null {
    const row = state.sessionListRowsByServerId?.[address.serverId]?.[address.sessionId];
    if (row) return row as unknown as SessionLike;
    const live = state.sessions?.[address.sessionId] as (SessionLike & { serverId?: unknown }) | undefined;
    // A bare-id record from another Home must not stand in for this one.
    if (live && (live.serverId === undefined || live.serverId === address.serverId)) return live;
    return null;
}

function toneOf(status: Pick<ReturnType<typeof getSessionStatus>, 'bucket' | 'tone'>): SessionSwitcherRowTone {
    if (status.tone === 'danger') return 'failed';
    if (status.tone === 'attention') return 'attention';
    if (status.bucket === 'working') return 'working';
    if (status.bucket === 'offline') return 'offline';
    return 'quiet';
}

function readExcerpt(state: RowsState, address: SessionAddress): string | null {
    const messages = readStoredSessionMessagesForAddress(state as never, address) as ReadonlyArray<{ kind?: string; text?: unknown }>;
    // The last thing said, by either side; tool calls are not "said".
    for (let index = messages.length - 1, seen = 0; index >= 0 && seen < 8; index -= 1, seen += 1) {
        const message = messages[index];
        if ((message?.kind === 'agent-text' || message?.kind === 'user-text') && typeof message.text === 'string') {
            const text = readableMessageText(message.text).replace(/\s+/g, ' ').trim();
            if (text) return text;
        }
    }
    return null;
}

export function readSessionSwitcherRows(params: Readonly<{
    entries: readonly SessionSwitcherEntry[];
    state: RowsState;
    addressByKey: ReadonlyMap<string, SessionAddress>;
    tabsById: ReadonlyMap<string, SessionSwitcherTabPresentation>;
    draftScope: ServerAccountScope | null;
    nowMs: number;
    isSessionVisible?: SessionRecordingVisibility;
}>): SessionSwitcherRow[] {
    const rows: SessionSwitcherRow[] = [];
    const isSessionVisible = params.isSessionVisible ?? readSessionRecordingVisibility();
    for (const entry of params.entries) {
        const tab = entry.tabId ? params.tabsById.get(entry.tabId) ?? null : null;
        const address = entry.sessionKey ? params.addressByKey.get(entry.sessionKey) ?? tab?.session ?? null : tab?.session ?? null;
        if (address) {
            if (!isSessionVisible(address)) continue;
            const session = readSession(params.state, address);
            const status = session ? getSessionStatus(session as never, params.nowMs) : null;
            const activityAt = session ? resolveSessionListRenderableMeaningfulActivityAt(session) : 0;
            const draft = params.draftScope && params.draftScope.serverId === address.serverId
                ? getExistingSessionDraftProjection(params.draftScope, address.sessionId)
                : null;
            rows.push({
                key: entry.key,
                section: entry.section,
                target: { kind: 'session', sessionId: address.sessionId, serverId: address.serverId, tabId: entry.tabId },
                title: tab && !session ? tab.title : getSessionName({ id: address.sessionId, metadata: session?.metadata ?? null } as never, address.serverId),
                agentId: session ? readSessionRowPresentationAgentId(session) : null,
                machineId: session ? resolveSessionMachineId(session.metadata as never) : null,
                serverId: address.serverId,
                icon: null,
                status: status && status.shouldShowStatus ? { text: status.statusText, tone: toneOf(status) } : null,
                timeLabel: activityAt > 0 ? formatShortRelativeTimeAt(activityAt, params.nowMs) : '',
                excerpt: readExcerpt(params.state, address),
                draft: draft?.listed && draft.preview ? draft.preview : null,
                unavailable: tab?.unavailable ?? false,
            });
            continue;
        }
        if (!tab || !entry.tabId) continue;
        rows.push({
            key: entry.key,
            section: entry.section,
            target: { kind: 'tab', tabId: entry.tabId },
            title: tab.title,
            agentId: null,
            machineId: null,
            serverId: null,
            icon: tab.icon,
            status: tab.context ? { text: tab.context, tone: tab.unavailable ? 'offline' : 'quiet' } : null,
            timeLabel: '',
            excerpt: null,
            draft: null,
            unavailable: tab.unavailable,
        });
    }
    return rows;
}
