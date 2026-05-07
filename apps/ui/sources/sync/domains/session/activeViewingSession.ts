/**
 * Module-scoped tracker for the session the user is currently viewing.
 *
 * The notification handler (`Notifications.setNotificationHandler`) runs outside
 * the React component tree so it cannot use hooks. This singleton provides a
 * synchronous way to check which session is on-screen, enabling same-session
 * notification suppression.
 */

type ActiveViewingSessionEntry = Readonly<{
    sessionId: string;
    activationId: number | null;
}>;

let activeViewingSessionEntries: ActiveViewingSessionEntry[] = [];

function getCurrentActiveViewingSessionEntry(): ActiveViewingSessionEntry | null {
    return activeViewingSessionEntries[activeViewingSessionEntries.length - 1] ?? null;
}

function removeActiveViewingSessionEntryAt(index: number): void {
    activeViewingSessionEntries = [
        ...activeViewingSessionEntries.slice(0, index),
        ...activeViewingSessionEntries.slice(index + 1),
    ];
}

export const getActiveViewingSessionId = (): string | null => getCurrentActiveViewingSessionEntry()?.sessionId ?? null;
export const getActiveViewingSessionActivationId = (): number | null => getCurrentActiveViewingSessionEntry()?.activationId ?? null;

export const setActiveViewingSessionId = (sessionId: string, activationId: number | null = null): void => {
    activeViewingSessionEntries = [
        ...activeViewingSessionEntries,
        { sessionId, activationId },
    ];
};

export const clearActiveViewingSessionId = (sessionId: string, activationId?: number | null): void => {
    if (activationId !== undefined) {
        const index = activeViewingSessionEntries.findIndex(
            (entry) => entry.sessionId === sessionId && entry.activationId === activationId,
        );
        if (index >= 0) {
            removeActiveViewingSessionEntryAt(index);
        }
        return;
    }

    const index = activeViewingSessionEntries.findIndex((entry) => entry.sessionId === sessionId);
    if (index >= 0) {
        removeActiveViewingSessionEntryAt(index);
    }
};

export const clearActiveViewingSessionsForServerScopeReset = (): void => {
    activeViewingSessionEntries = [];
};
