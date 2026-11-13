import { log } from "@/utils/logging/log";

/** The tail of each Session's post-commit fan-out; an entry exists only while fan-out is pending. */
const pendingBySessionId = new Map<string, Promise<void>>();

/**
 * Client fan-out of a committed Session write. The writer acknowledges its caller when the write
 * commits and hands its fan-out (client updates, badge work) here: it runs after every earlier
 * fan-out of the same Session, so clients receive one Session's updates in commit order whatever
 * transport (socket or HTTP) carried the writes. Resolves when this fan-out has run; a failure is
 * logged, never thrown, because the write is already acknowledged.
 */
export function publishSessionAfterCommit(sessionId: string, label: string, publish: () => Promise<void>): Promise<void> {
    const tail = (pendingBySessionId.get(sessionId) ?? Promise.resolve()).then(publish).catch((error: unknown) => {
        log({ module: "session-publication", level: "warn", sessionId }, `${label} publication failed: ${error}`);
    });
    pendingBySessionId.set(sessionId, tail);
    void tail.then(() => { if (pendingBySessionId.get(sessionId) === tail) pendingBySessionId.delete(sessionId); });
    return tail;
}
