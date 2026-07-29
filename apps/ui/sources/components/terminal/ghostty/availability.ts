import {
    normalizeTerminalNativeAvailability,
    type TerminalNativeAvailability,
} from '@happier-dev/terminal-native';

export type GhosttyRendererSelection =
    | Readonly<{ renderer: 'ios-ghosttykit'; availability: Extract<TerminalNativeAvailability, { available: true }> }>
    | Readonly<{ renderer: 'xterm-webview'; reason: string }>;

export type GhosttyRendererSelectionOptions = Readonly<{
    featureEnabled: boolean;
    platform: string;
    availability: TerminalNativeAvailability | unknown;
    accessibilityAccepted: boolean;
    packageProofAccepted: boolean;
    crashFallbackAvailable: boolean;
}>;

export function resolveGhosttyRendererSelection(options: GhosttyRendererSelectionOptions): GhosttyRendererSelection {
    if (options.platform !== 'ios') {
        return { renderer: 'xterm-webview', reason: 'unsupported-platform' };
    }

    if (!options.featureEnabled) {
        return { renderer: 'xterm-webview', reason: 'feature-disabled' };
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

    if (availability.platform !== 'ios' || availability.renderer !== 'ios-ghosttykit') {
        return { renderer: 'xterm-webview', reason: 'renderer-unavailable' };
    }

    if (!options.accessibilityAccepted && availability.accessibility !== 'native') {
        return { renderer: 'xterm-webview', reason: 'accessibility-unproven' };
    }

    return { renderer: 'ios-ghosttykit', availability };
}
