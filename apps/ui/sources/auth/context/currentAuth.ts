import type { AuthContextType } from './AuthContext';

// The imperative bridge shares the provider's exact value without importing
// React, connection restore, or the Voice/AppShell presentation graph.
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null): void {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
