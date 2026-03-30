import type { SessionHandoffStatus } from '@happier-dev/protocol';

export type SessionHandoffProgressUpdate = Readonly<{
    sessionId: string;
    targetMachineId: string;
    status: SessionHandoffStatus;
}>;

type SessionHandoffProgressListener = (update: SessionHandoffProgressUpdate) => void;

const listeners = new Set<SessionHandoffProgressListener>();

export function subscribeSessionHandoffProgress(listener: SessionHandoffProgressListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function publishSessionHandoffProgress(update: SessionHandoffProgressUpdate): void {
    for (const listener of [...listeners]) {
        listener(update);
    }
}
