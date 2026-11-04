import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';

type Rows = Readonly<Record<string, SessionListRenderableSession>>;
export type SessionListBotRowsByServerId = Readonly<Record<string, Rows | undefined>>;

const EMPTY_ROWS: Rows = {};
const EMPTY_SELECTION: SessionListBotRowsByServerId = {};

/** Select loaded Bot rows when the list publishes, using its exact changed ids. */
export function publishSessionListBotSelection(
    previousRowsByServerId: SessionListBotRowsByServerId,
    rowsByServerId: SessionListBotRowsByServerId,
    previous: SessionListBotRowsByServerId = EMPTY_SELECTION,
    changedSessionIds?: readonly string[],
): SessionListBotRowsByServerId {
    if (previousRowsByServerId === rowsByServerId) return previous;
    let selection = previous;
    for (const serverId of new Set([...Object.keys(previousRowsByServerId), ...Object.keys(rowsByServerId)])) {
        if (previousRowsByServerId[serverId] === rowsByServerId[serverId]) continue;
        const rows = rowsByServerId[serverId];
        if (!rows) {
            if (selection[serverId] !== undefined) {
                const { [serverId]: _removed, ...retained } = selection;
                selection = retained;
            }
            continue;
        }
        const previousBots = previous[serverId] ?? EMPTY_ROWS;
        let changedBots: Record<string, SessionListRenderableSession> | undefined;
        // Structural replacement without a delta is the only full-admission path.
        const candidates = previousRowsByServerId[serverId]
            ? changedSessionIds ?? new Set([...Object.keys(previousBots), ...Object.keys(rows)])
            : Object.keys(rows);
        for (const sessionId of candidates) {
            const row = rows[sessionId];
            if (row === previousBots[sessionId]) continue;
            const bot = row && readSessionBotV1(row.metadata?.bot)?.kind === 'bot' ? row : undefined;
            if (bot === previousBots[sessionId]) continue;
            changedBots ??= { ...previousBots };
            if (bot) changedBots[sessionId] = bot;
            else delete changedBots[sessionId];
        }
        if (changedBots) selection = { ...selection, [serverId]: changedBots };
    }
    return selection;
}
