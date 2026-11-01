import type { EmbeddedTerminalPaneStatus } from '@/components/terminal/embedded/types';

export type TerminalReaderConnection = Readonly<{
    status: EmbeddedTerminalPaneStatus;
    error: string | null;
}>;

const idleConnection: TerminalReaderConnection = { status: 'idle', error: null };
type TerminalReaderEntry = {
    owner: symbol | null;
    reconnect: ((restart: boolean) => void) | null;
    connection: TerminalReaderConnection;
    listeners: Set<() => void>;
    availabilityListeners: Set<() => void>;
};
const terminalReaders = new Map<string, TerminalReaderEntry>();

function entryFor(terminalKey: string): TerminalReaderEntry {
    let entry = terminalReaders.get(terminalKey);
    if (!entry) {
        entry = { owner: null, reconnect: null, connection: idleConnection, listeners: new Set(), availabilityListeners: new Set() };
        terminalReaders.set(terminalKey, entry);
    }
    return entry;
}

function discardUnusedEntry(terminalKey: string, entry: TerminalReaderEntry): void {
    if (!entry.owner && entry.listeners.size === 0 && entry.availabilityListeners.size === 0) {
        terminalReaders.delete(terminalKey);
    }
}

export function claimTerminalReaderLease(terminalKey: string, ownerToken: symbol, reconnect: (restart: boolean) => void): boolean {
    const entry = entryFor(terminalKey);
    if (entry.owner && entry.owner !== ownerToken) return false;
    entry.owner = ownerToken;
    entry.reconnect = reconnect;
    return true;
}

export function releaseTerminalReaderLease(terminalKey: string, ownerToken: symbol): void {
    const entry = terminalReaders.get(terminalKey);
    if (!entry || entry.owner !== ownerToken) return;
    entry.owner = null;
    entry.reconnect = null;
    // Failures and exits are shared outcomes, not invitations for mounted followers
    // to repeatedly reconnect each other. A new open or explicit retry can try again.
    if (entry.connection.status !== 'error' && entry.connection.status !== 'exited') {
        for (const listener of entry.availabilityListeners) listener();
    }
    discardUnusedEntry(terminalKey, entry);
}

export function hasTerminalReaderLease(terminalKey: string, ownerToken: symbol): boolean {
    return terminalReaders.get(terminalKey)?.owner === ownerToken;
}

export function reconnectTerminalReader(terminalKey: string, restart: boolean): boolean {
    const reconnect = terminalReaders.get(terminalKey)?.reconnect;
    if (!reconnect) return false;
    reconnect(restart);
    return true;
}

export function readTerminalReaderConnection(terminalKey: string): TerminalReaderConnection {
    return terminalReaders.get(terminalKey)?.connection ?? idleConnection;
}

export function publishTerminalReaderConnection(terminalKey: string, ownerToken: symbol, connection: TerminalReaderConnection): void {
    const entry = terminalReaders.get(terminalKey);
    if (!entry || entry.owner !== ownerToken) return;
    if (entry.connection.status === connection.status && entry.connection.error === connection.error) return;
    entry.connection = connection;
    for (const listener of entry.listeners) listener();
}

export function subscribeTerminalReaderConnection(terminalKey: string, listener: () => void): () => void {
    const entry = entryFor(terminalKey);
    entry.listeners.add(listener);
    return () => {
        entry.listeners.delete(listener);
        discardUnusedEntry(terminalKey, entry);
    };
}

export function subscribeTerminalReaderLeaseAvailability(terminalKey: string, listener: () => void): () => void {
    const entry = entryFor(terminalKey);
    entry.availabilityListeners.add(listener);
    return () => {
        entry.availabilityListeners.delete(listener);
        discardUnusedEntry(terminalKey, entry);
    };
}
