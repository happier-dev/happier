export type SessionReadCursorOperation =
    | { kind: "advance"; lastViewedSessionSeq: number }
    | { kind: "mark-read" }
    | { kind: "mark-unread" };

export type SessionReadCursorReadState = "read" | "unread" | "empty";

export type ResolveSessionReadCursorOperationInput = Readonly<{
    sessionSeq: number | null | undefined;
    currentLastViewedSessionSeq: number | null | undefined;
    operation: SessionReadCursorOperation;
}>;

export type ResolveSessionReadCursorOperationResult = Readonly<{
    nextLastViewedSessionSeq: number | null;
    didChange: boolean;
    readState: SessionReadCursorReadState;
}>;

function normalizeSeq(value: number | null | undefined): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;
}

function normalizeCursor(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : null;
}

export function resolveSessionReadState(
    sessionSeqInput: number | null | undefined,
    cursorInput: number | null | undefined,
): SessionReadCursorReadState {
    const sessionSeq = normalizeSeq(sessionSeqInput);
    const cursor = normalizeCursor(cursorInput);
    if (sessionSeq <= 0) {
        return "empty";
    }
    return typeof cursor === "number" && cursor >= sessionSeq ? "read" : "unread";
}

export function resolveSessionReadCursorOperation(
    input: ResolveSessionReadCursorOperationInput,
): ResolveSessionReadCursorOperationResult {
    const sessionSeq = normalizeSeq(input.sessionSeq);
    const currentCursor = normalizeCursor(input.currentLastViewedSessionSeq);

    if (input.operation.kind === "advance") {
        const incomingCursor = Math.max(0, Math.floor(input.operation.lastViewedSessionSeq));
        const targetCursor = Math.min(incomingCursor, sessionSeq);
        const comparableCurrent = currentCursor ?? -1;
        const nextCursor = targetCursor > comparableCurrent ? targetCursor : currentCursor;
        return {
            nextLastViewedSessionSeq: nextCursor,
            didChange: nextCursor !== currentCursor,
            readState: resolveSessionReadState(sessionSeq, nextCursor),
        };
    }

    if (input.operation.kind === "mark-read") {
        const targetCursor = sessionSeq;
        return {
            nextLastViewedSessionSeq: targetCursor,
            didChange: currentCursor !== targetCursor,
            readState: resolveSessionReadState(sessionSeq, targetCursor),
        };
    }

    if (sessionSeq <= 0) {
        return {
            nextLastViewedSessionSeq: currentCursor,
            didChange: false,
            readState: "empty",
        };
    }

    if (currentCursor === null) {
        return {
            nextLastViewedSessionSeq: null,
            didChange: false,
            readState: "unread",
        };
    }

    const targetCursor = Math.max(0, sessionSeq - 1);
    const nextCursor = currentCursor > targetCursor ? targetCursor : currentCursor;
    return {
        nextLastViewedSessionSeq: nextCursor,
        didChange: nextCursor !== currentCursor,
        readState: resolveSessionReadState(sessionSeq, nextCursor),
    };
}
