import {
    normalizeTerminalNativeAvailability,
    type TerminalNativeAvailability,
} from '@happier-dev/terminal-native';

export type TermuxRendererSelection =
    | Readonly<{ renderer: 'android-termux'; availability: Extract<TerminalNativeAvailability, { available: true }> }>
    | Readonly<{ renderer: 'xterm-webview'; reason: string }>;

export type TermuxRendererSelectionOptions = Readonly<{
    featureEnabled: boolean;
    platform: string;
    availability: TerminalNativeAvailability | unknown;
    accessibilityAccepted: boolean;
    legalAccepted: boolean;
    packageProofAccepted: boolean;
    crashFallbackAvailable: boolean;
}>;

export function resolveTermuxRendererSelection(options: TermuxRendererSelectionOptions): TermuxRendererSelection {
    if (options.platform !== 'android') {
        return { renderer: 'xterm-webview', reason: 'unsupported-platform' };
    }

    if (!options.featureEnabled) {
        return { renderer: 'xterm-webview', reason: 'feature-disabled' };
    }

    if (!options.legalAccepted) {
        return { renderer: 'xterm-webview', reason: 'legal-not-approved' };
    }

    if (!options.packageProofAccepted) {
        return { renderer: 'xterm-webview', reason: 'package-proof-unaccepted' };
    }

    if (!options.crashFallbackAvailable) {
        return { renderer: 'xterm-webview', reason: 'crash-fallback-unavailable' };
    }

    const availability = normalizeTerminalNativeAvailability(options.availability);

    if (!availability.available) {
        return { renderer: 'xterm-webview', reason: availability.reason };
    }

    if (availability.platform !== 'android' || availability.renderer !== 'android-termux') {
        return { renderer: 'xterm-webview', reason: 'renderer-unavailable' };
    }

    if (!options.accessibilityAccepted && availability.accessibility !== 'native') {
        return { renderer: 'xterm-webview', reason: 'accessibility-unproven' };
    }

    return { renderer: 'android-termux', availability };
}
