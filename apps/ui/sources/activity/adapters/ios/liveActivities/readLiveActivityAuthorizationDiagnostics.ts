import { requireOptionalNativeModule } from 'expo-modules-core';
import * as ExpoWidgets from 'expo-widgets';

type LiveActivityAuthorizationSource =
    | 'expo-widgets'
    | 'native-shim'
    | 'unavailable';

type LiveActivityAuthorizationStatus =
    | 'enabled'
    | 'disabled'
    | 'unavailable';

type RawLiveActivityAuthorizationDiagnostics = Readonly<{
    areActivitiesEnabled?: boolean;
    frequentPushesEnabled?: boolean;
}>;

type LiveActivityAuthorizationDiagnosticsProvider = Readonly<{
    getLiveActivityAuthorizationDiagnostics: () => Promise<RawLiveActivityAuthorizationDiagnostics>;
}>;

type ExpoWidgetsAuthorizationBridge = typeof ExpoWidgets & Partial<LiveActivityAuthorizationDiagnosticsProvider>;

export type LiveActivityAuthorizationDiagnostics = Readonly<{
    source: LiveActivityAuthorizationSource;
    activities: LiveActivityAuthorizationStatus;
    frequentUpdates: LiveActivityAuthorizationStatus;
}>;

function normalizeStatus(value: boolean | undefined): LiveActivityAuthorizationStatus {
    if (value === true) return 'enabled';
    if (value === false) return 'disabled';
    return 'unavailable';
}

function normalizeDiagnostics(
    source: LiveActivityAuthorizationSource,
    diagnostics: RawLiveActivityAuthorizationDiagnostics,
): LiveActivityAuthorizationDiagnostics {
    return {
        source,
        activities: normalizeStatus(diagnostics.areActivitiesEnabled),
        frequentUpdates: normalizeStatus(diagnostics.frequentPushesEnabled),
    };
}

function unavailableDiagnostics(): LiveActivityAuthorizationDiagnostics {
    return {
        source: 'unavailable',
        activities: 'unavailable',
        frequentUpdates: 'unavailable',
    };
}

async function readFromExpoWidgets(): Promise<LiveActivityAuthorizationDiagnostics | null> {
    let provider: ExpoWidgetsAuthorizationBridge['getLiveActivityAuthorizationDiagnostics'];
    try {
        provider = (ExpoWidgets as ExpoWidgetsAuthorizationBridge).getLiveActivityAuthorizationDiagnostics;
    } catch {
        return null;
    }
    if (typeof provider !== 'function') {
        return null;
    }
    try {
        return normalizeDiagnostics('expo-widgets', await provider());
    } catch {
        return null;
    }
}

async function readFromNativeShim(): Promise<LiveActivityAuthorizationDiagnostics | null> {
    const provider = requireOptionalNativeModule<LiveActivityAuthorizationDiagnosticsProvider>(
        'HappierLiveActivityAuthorization',
    );
    if (!provider || typeof provider.getLiveActivityAuthorizationDiagnostics !== 'function') {
        return null;
    }
    try {
        return normalizeDiagnostics('native-shim', await provider.getLiveActivityAuthorizationDiagnostics());
    } catch {
        return null;
    }
}

export async function readLiveActivityAuthorizationDiagnostics(): Promise<LiveActivityAuthorizationDiagnostics> {
    return await readFromExpoWidgets()
        ?? await readFromNativeShim()
        ?? unavailableDiagnostics();
}
