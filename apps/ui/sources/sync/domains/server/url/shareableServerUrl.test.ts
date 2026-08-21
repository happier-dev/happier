import { describe, expect, it } from 'vitest';

import {
    resolvePreferredShareableServerUrl,
    sanitizeServerUrlForShareableLink,
} from './shareableServerUrl';

describe('shareableServerUrl', () => {
    it('prefers an explicit shareable relay URL over canonical and active URLs', () => {
        expect(resolvePreferredShareableServerUrl({
            preferredShareableServerUrl: 'https://relay.example.ts.net/path?token=abc#frag',
            canonicalServerUrl: 'https://api.example.test',
            activeServerUrl: 'https://active.example.test',
        })).toBe('https://relay.example.ts.net/path');
    });

    it('falls back to canonical and active URLs only when they are safe to share', () => {
        expect(resolvePreferredShareableServerUrl({
            preferredShareableServerUrl: null,
            canonicalServerUrl: 'http://127.0.0.1:3005',
            activeServerUrl: 'https://active.example.test',
        })).toBe('https://active.example.test');
    });

    it('sanitizes credentials out of shareable URLs', () => {
        expect(sanitizeServerUrlForShareableLink('https://user:pass@relay.example.ts.net/')).toBe('https://relay.example.ts.net');
    });

    it('refuses every loopback address, not only 127.0.0.1', () => {
        // A shareable link is handed to another device, so this path asks the
        // reachability question. Anything in 127.0.0.0/8 resolves back to the
        // machine that produced the link and is useless to the receiver.
        expect(sanitizeServerUrlForShareableLink('http://127.0.0.1:3005')).toBeNull();
        expect(sanitizeServerUrlForShareableLink('http://127.0.0.2:3005')).toBeNull();
        expect(sanitizeServerUrlForShareableLink('http://127.255.255.254:3005')).toBeNull();
    });

    it('refuses a fully qualified loopback name carrying a trailing dot', () => {
        expect(sanitizeServerUrlForShareableLink('http://localhost.:3005')).toBeNull();
        expect(sanitizeServerUrlForShareableLink('http://relay.localhost.:3005')).toBeNull();
    });

    it('still shares a routable relay URL', () => {
        expect(sanitizeServerUrlForShareableLink('https://relay.example.ts.net:3005'))
            .toBe('https://relay.example.ts.net:3005');
    });
});
