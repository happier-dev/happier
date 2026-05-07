type TerminalReaderListener = () => void;

const terminalReaderOwners = new Map<string, symbol>();
const terminalReaderListeners = new Map<string, Set<TerminalReaderListener>>();

function notifyTerminalReaderListeners(terminalKey: string): void {
    const listeners = terminalReaderListeners.get(terminalKey);
    if (!listeners || listeners.size === 0) {
        return;
    }
    for (const listener of listeners) {
        listener();
    }
}

export function claimTerminalReaderLease(terminalKey: string, ownerToken: symbol): boolean {
    const currentOwner = terminalReaderOwners.get(terminalKey);
    if (currentOwner && currentOwner !== ownerToken) {
        return false;
    }
    terminalReaderOwners.set(terminalKey, ownerToken);
    return true;
}

export function releaseTerminalReaderLease(terminalKey: string, ownerToken: symbol): void {
    if (terminalReaderOwners.get(terminalKey) !== ownerToken) {
        return;
    }
    terminalReaderOwners.delete(terminalKey);
    notifyTerminalReaderListeners(terminalKey);
}

export function hasTerminalReaderLease(terminalKey: string, ownerToken: symbol): boolean {
    return terminalReaderOwners.get(terminalKey) === ownerToken;
}

export function subscribeTerminalReaderLeaseAvailability(terminalKey: string, listener: TerminalReaderListener): () => void {
    const existing = terminalReaderListeners.get(terminalKey);
    const listeners = existing ?? new Set<TerminalReaderListener>();
    listeners.add(listener);
    if (!existing) {
        terminalReaderListeners.set(terminalKey, listeners);
    }

    return () => {
        const current = terminalReaderListeners.get(terminalKey);
        if (!current) {
            return;
        }
        current.delete(listener);
        if (current.size === 0) {
            terminalReaderListeners.delete(terminalKey);
        }
    };
}
