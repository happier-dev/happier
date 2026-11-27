import type { Socket } from "socket.io";
import { z } from "zod";

import { transcriptInterestRoom } from "../socketRooms";
import { readHappierSocketData } from "./socketData";

const TranscriptInterestSetSchema = z.object({ sessionIds: z.array(z.string()) }).strict();

export type TranscriptInterestSetAck =
    | { ok: true }
    | { ok: false; error: "not-allowed" | "invalid-payload" | "apply-failed" };

function normalizeSessionIds(values: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    for (const value of values) {
        const sessionId = value.trim();
        if (sessionId) seen.add(sessionId);
    }
    return Array.from(seen);
}

/**
 * Runtime transcript interest for a connection that declared `transcriptInterestDeclared`.
 *
 * Each set replaces the whole previous set: new rooms are joined before dropped rooms are left, so a
 * session kept in both sets never has a delivery gap. The set lives on the socket only; nothing is
 * buffered server-side, so a reconnected client starts from the empty handshake set and resends.
 */
export function registerTranscriptInterestSocketEvent(socket: Socket): void {
    socket.on("transcript-interest:set", async (input: unknown, ack?: (response: TranscriptInterestSetAck) => void) => {
        const data = readHappierSocketData(socket);
        const userId = data.userId;
        const allowed = data.clientType === "user-scoped"
            && data.transcriptInterestDeclared === true
            && typeof userId === "string"
            && userId.length > 0;
        const parsed = TranscriptInterestSetSchema.safeParse(input);
        if (!allowed || !parsed.success) {
            ack?.({ ok: false, error: allowed ? "invalid-payload" : "not-allowed" });
            return;
        }

        const previous = data.transcriptInterestSessionIds ?? [];
        const next = normalizeSessionIds(parsed.data.sessionIds);
        const previousSessionIds = new Set(previous);
        const nextSessionIds = new Set(next);
        try {
            await Promise.all(
                next
                    .filter((sessionId) => !previousSessionIds.has(sessionId))
                    .map((sessionId) => socket.join(transcriptInterestRoom(userId, sessionId))),
            );
            await Promise.all(
                previous
                    .filter((sessionId) => !nextSessionIds.has(sessionId))
                    .map((sessionId) => socket.leave(transcriptInterestRoom(userId, sessionId))),
            );
        } catch {
            ack?.({ ok: false, error: "apply-failed" });
            return;
        }

        data.transcriptInterestSessionIds = next;
        ack?.({ ok: true });
    });
}
