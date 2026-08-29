import { describe, expect, it } from 'vitest';

async function loadTermuxAvailabilityModule() {
    return import('./availability').catch((error: unknown) => error);
}

describe('Termux terminal renderer selection', () => {
    it('keeps xterm WebView selected when Termux package proof is not accepted', async () => {
        const mod = await loadTermuxAvailabilityModule();
        expect(mod).toHaveProperty('resolveTermuxRendererSelection');
        const selection = mod as {
            resolveTermuxRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveTermuxRendererSelection({
            featureEnabled: true,
            platform: 'android',
            accessibilityAccepted: true,
            packageProofAccepted: false,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'android',
                renderer: 'android-termux',
                moduleVersion: '0.0.0',
                accessibility: 'native',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'package-proof-unaccepted',
        });
    });

    it('keeps xterm WebView selected when Termux crash fallback is unavailable', async () => {
        const mod = await loadTermuxAvailabilityModule();
        expect(mod).toHaveProperty('resolveTermuxRendererSelection');
        const selection = mod as {
            resolveTermuxRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveTermuxRendererSelection({
            featureEnabled: true,
            platform: 'android',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: false,
            availability: {
                available: true,
                platform: 'android',
                renderer: 'android-termux',
                moduleVersion: '0.0.0',
                accessibility: 'native',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'crash-fallback-unavailable',
        });
    });

    it('keeps xterm WebView selected when Termux availability is for a different platform', async () => {
        const mod = await loadTermuxAvailabilityModule();
        expect(mod).toHaveProperty('resolveTermuxRendererSelection');
        const selection = mod as {
            resolveTermuxRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveTermuxRendererSelection({
            featureEnabled: true,
            platform: 'android',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'ios',
                renderer: 'android-termux',
                moduleVersion: '0.0.0',
                accessibility: 'native',
            },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'renderer-unavailable',
        });
    });

    it('keeps xterm WebView selected with a stable reason when native availability is malformed', async () => {
        const mod = await loadTermuxAvailabilityModule();
        expect(mod).toHaveProperty('resolveTermuxRendererSelection');
        const selection = mod as {
            resolveTermuxRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveTermuxRendererSelection({
            featureEnabled: true,
            platform: 'android',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: { available: false },
        })).toEqual({
            renderer: 'xterm-webview',
            reason: 'renderer-unavailable',
        });
    });

    it('selects Android Termux only when feature, proof, fallback, availability, and accessibility gates pass', async () => {
        const mod = await loadTermuxAvailabilityModule();
        expect(mod).toHaveProperty('resolveTermuxRendererSelection');
        const selection = mod as {
            resolveTermuxRendererSelection: (options: {
                featureEnabled: boolean;
                platform: string;
                availability: unknown;
                accessibilityAccepted: boolean;
                packageProofAccepted: boolean;
                crashFallbackAvailable: boolean;
            }) => unknown;
        };

        expect(selection.resolveTermuxRendererSelection({
            featureEnabled: true,
            platform: 'android',
            accessibilityAccepted: true,
            packageProofAccepted: true,
            crashFallbackAvailable: true,
            availability: {
                available: true,
                platform: 'android',
                renderer: 'android-termux',
                moduleVersion: '0.0.0',
                accessibility: 'fallback-required',
            },
        })).toEqual({
            renderer: 'android-termux',
            availability: {
                available: true,
                platform: 'android',
                renderer: 'android-termux',
                moduleVersion: '0.0.0',
                accessibility: 'fallback-required',
            },
        });
    });
});
