type ExternalSessionFollowLeaseArchiveHandler = (sessionId: string) => Promise<void> | void;

const archiveHandlers = new Set<ExternalSessionFollowLeaseArchiveHandler>();

export function registerExternalSessionFollowLeaseArchiveHandler(
    handler: ExternalSessionFollowLeaseArchiveHandler,
): () => void {
    archiveHandlers.add(handler);
    let registered = true;
    return () => {
        if (!registered) {
            return;
        }
        registered = false;
        archiveHandlers.delete(handler);
    };
}

export async function releaseExternalSessionFollowLeasesForArchivedSession(sessionId: string): Promise<void> {
    const handlers = [...archiveHandlers];
    await Promise.all(handlers.map(async (handler) => {
        try {
            await handler(sessionId);
        } catch {
            // Archive already succeeded; follow cleanup is best-effort across local runtime managers.
        }
    }));
}
