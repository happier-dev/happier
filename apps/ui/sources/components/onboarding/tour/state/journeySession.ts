import * as React from 'react';

import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';

let journeySessionActive = false;
const listeners = new Set<() => void>();

function emitJourneySessionChanged(): void {
    for (const listener of listeners) {
        listener();
    }
}

function subscribeJourneySession(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getJourneySessionSnapshot(): boolean {
    return journeySessionActive;
}

export function beginOnboardingJourneySession(): void {
    if (journeySessionActive) return;
    journeySessionActive = true;
    emitJourneySessionChanged();
}

export function endOnboardingJourneySession(): void {
    if (!journeySessionActive) return;
    journeySessionActive = false;
    emitJourneySessionChanged();
}

export function doesOnboardingJourneyOwnTransientDemoServer(
    onboardingJourneyActive: boolean,
): boolean {
    return onboardingJourneyActive && isDemoModeActive();
}

export function useOnboardingJourneySessionActive(): boolean {
    return React.useSyncExternalStore(
        subscribeJourneySession,
        getJourneySessionSnapshot,
        getJourneySessionSnapshot,
    );
}
