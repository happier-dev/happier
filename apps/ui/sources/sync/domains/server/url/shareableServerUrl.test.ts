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
});
