type SessionComposerPresentationTarget = Readonly<{
    readRevision: () => number;
    replace: (text: string, expectedRevision: number) => number;
}>;

const targets = new Map<string, SessionComposerPresentationTarget>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function registerSessionComposerPresentationTarget(
    sessionIdRaw: string,
    target: SessionComposerPresentationTarget,
): () => void {
    const sessionId = sessionIdRaw.trim();
    targets.set(sessionId, target);
    emit();
    return () => {
        if (targets.get(sessionId) !== target) return;
        targets.delete(sessionId);
        emit();
    };
}

export function readSessionComposerPresentationTarget(sessionIdRaw: string): Readonly<{
    revision: number;
    replace: SessionComposerPresentationTarget['replace'];
}> | null {
    const target = targets.get(sessionIdRaw.trim());
    return target ? Object.freeze({ revision: target.readRevision(), replace: target.replace }) : null;
}

export function notifySessionComposerPresentationTargetChanged(): void {
    emit();
}

export function subscribeSessionComposerPresentationTargets(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
