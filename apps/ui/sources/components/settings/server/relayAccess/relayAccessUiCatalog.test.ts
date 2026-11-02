import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayAccessProviderSupportsTarget } from './relayAccessUiCatalog';

describe('Home relay descriptor targets', () => {
    afterEach(() => vi.unstubAllEnvs());
    it('honors the descriptor build policy for forced as well as listed choices', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'setup.relayAccess.allowTailscale');
        expect(relayAccessProviderSupportsTarget('tailscaleServe', { kind: 'local' })).toBe(false);
        expect(relayAccessProviderSupportsTarget('tailscaleFunnel', { kind: 'local' })).toBe(false);
        expect(relayAccessProviderSupportsTarget('lan', { kind: 'local' })).toBe(true);
    });
    it('refuses an unknown provider instead of advertising unconditional support', () => {
        expect(relayAccessProviderSupportsTarget('missing-contribution', { kind: 'local' })).toBe(false);
    });
    it('does not offer native Machine ingress or membership as Home relay choices', () => {
        expect(relayAccessProviderSupportsTarget('caddy', { kind: 'local' })).toBe(false);
        expect(relayAccessProviderSupportsTarget('tailscale', { kind: 'local' })).toBe(false);
    });
    it('preserves the built-in Home local and addressed SSH targets', () => {
        expect(relayAccessProviderSupportsTarget('localOnly', { kind: 'local' })).toBe(true);
        expect(relayAccessProviderSupportsTarget('lan', { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } })).toBe(true);
    });
});
