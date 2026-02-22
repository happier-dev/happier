/**
 * Module-scoped tracker for the session the user is currently viewing.
 *
 * The notification handler (`Notifications.setNotificationHandler`) runs outside
 * the React component tree so it cannot use hooks. This singleton provides a
 * synchronous way to check which session is on-screen, enabling same-session
 * notification suppression.
 */

let _activeViewingSessionId: string | null = null;

export const getActiveViewingSessionId = (): string | null => _activeViewingSessionId;

export const setActiveViewingSessionId = (sessionId: string): void => {
    _activeViewingSessionId = sessionId;
};

export const clearActiveViewingSessionId = (sessionId: string): void => {
    // Only clear if the current value matches — avoids a race when two
    // SessionViews mount/unmount in rapid succession during navigation.
    if (_activeViewingSessionId === sessionId) {
        _activeViewingSessionId = null;
    }
};
