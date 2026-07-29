import { describe, expect, it } from 'vitest';

async function loadGhosttyAvailabilityModule() {
    return import('./availability').catch((error: unknown) => error);
}

describe('Ghostty terminal renderer selection', () => {
    it('keeps xterm WebView selected when Ghostty accessibility is unproven', async () => {
        const mod = await loadGhosttyAvailabilityModule();
        expect(mod).toHaveProperty('resolveGhosttyRendererSelection');
        const selection = mod as {
            resolveGhosttyRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveGhosttyRendererSelection({
            featureEnabled: true,
            platform: 'ios',
            accessibilityAccepted: false,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'ios',
                renderer: 'ios-ghosttykit',
                moduleVersion: '0.0.0',
                accessibility: 'fallback-required',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'accessibility-unproven',
        });
    });

    it('keeps xterm WebView selected when Ghostty package proof is not accepted', async () => {
        const mod = await loadGhosttyAvailabilityModule();
        expect(mod).toHaveProperty('resolveGhosttyRendererSelection');
        const selection = mod as {
            resolveGhosttyRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveGhosttyRendererSelection({
            featureEnabled: true,
            platform: 'ios',
            accessibilityAccepted: true,
            packageProofAccepted: false,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'ios',
                renderer: 'ios-ghosttykit',
                moduleVersion: '0.0.0',
                accessibility: 'native',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'package-proof-unaccepted',
        });
    });

    it('keeps xterm WebView selected when Ghostty crash fallback is unavailable', async () => {
        const mod = await loadGhosttyAvailabilityModule();
        expect(mod).toHaveProperty('resolveGhosttyRendererSelection');
        const selection = mod as {
            resolveGhosttyRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveGhosttyRendererSelection({
            featureEnabled: true,
            platform: 'ios',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: false,
            availability: {
                available: true,
                platform: 'ios',
                renderer: 'ios-ghosttykit',
                moduleVersion: '0.0.0',
                accessibility: 'native',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'crash-fallback-unavailable',
        });
    });

    it('keeps xterm WebView selected when Ghostty availability is for a different platform', async () => {
        const mod = await loadGhosttyAvailabilityModule();
        expect(mod).toHaveProperty('resolveGhosttyRendererSelection');
        const selection = mod as {
            resolveGhosttyRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveGhosttyRendererSelection({
            featureEnabled: true,
            platform: 'ios',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'android',
                renderer: 'ios-ghosttykit',
                moduleVersion: '0.0.0',
                accessibility: 'native',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'renderer-unavailable',
        });
    });

    it('keeps xterm WebView selected with a stable reason when native availability is malformed', async () => {
        const mod = await loadGhosttyAvailabilityModule();
        expect(mod).toHaveProperty('resolveGhosttyRendererSelection');
        const selection = mod as {
            resolveGhosttyRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveGhosttyRendererSelection({
            featureEnabled: true,
            platform: 'ios',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: { available: false },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'renderer-unavailable',
        });
    });

    it('selects iOS Ghostty only when feature, proof, fallback, availability, and accessibility gates pass', async () => {
        const mod = await loadGhosttyAvailabilityModule();
        expect(mod).toHaveProperty('resolveGhosttyRendererSelection');
        const selection = mod as {
            resolveGhosttyRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveGhosttyRendererSelection({
            featureEnabled: true,
            platform: 'ios',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'ios',
                renderer: 'ios-ghosttykit',
                moduleVersion: '0.0.0',
                accessibility: 'fallback-required',
            },
        })).toEqual({
            renderer: 'ios-ghosttykit',
            availability: {
                available: true,
                platform: 'ios',
                renderer: 'ios-ghosttykit',
                moduleVersion: '0.0.0',
                accessibility: 'fallback-required',
            },
        });
    });
});
