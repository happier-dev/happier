import type { ClientConnection } from "@/app/events/eventRouter";
import { log } from "@/utils/logging/log";
import type { Socket } from "socket.io";

import { applyReleasedUiV021SessionEnd } from "./applyReleasedUiV021SessionEnd";

export const RELEASED_UI_V0_2_1_SESSION_END_STALE_WINDOW_MS = 10 * 60 * 1_000;

/**
 * Adapts the user-scoped `session-end` contract from exact UI/server-v0.2.1 at
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2. Remove this adapter when exact
 * 0.2.1 leaves the supported predecessor window.
 */
export function registerReleasedUiV021SessionEndSocketEvent(params: Readonly<{
    socket: Socket;
    accountId: string;
    connection: Extract<ClientConnection, { connectionType: "user-scoped" }>;
    now?: () => number;
}>): void {
    const now = params.now ?? Date.now;
    params.socket.on("session-end", (raw: unknown) => {
        void (async () => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
            const { sid, time } = raw as { sid?: unknown; time?: unknown };
            if (typeof sid !== "string" || sid.trim().length === 0) return;
            if (typeof time !== "number" || !Number.isFinite(time)) return;
            const serverNow = now();
            const observedAt = Math.max(0, Math.min(Math.floor(time), serverNow));
            if (observedAt < serverNow - RELEASED_UI_V0_2_1_SESSION_END_STALE_WINDOW_MS) return;
            await applyReleasedUiV021SessionEnd({
                accountId: params.accountId,
                sessionId: sid,
                observedAt,
                connection: params.connection,
            });
        })().catch((error) => {
            log(
                { module: "released-ui-v0.2.1-session-end", error },
                "Failed to apply released UI session-end event",
            );
        });
    });
}
