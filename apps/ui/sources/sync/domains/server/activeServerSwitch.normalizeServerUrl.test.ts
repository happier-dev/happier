import { describe, it, expect } from 'vitest';
import { normalizeServerUrl } from './activeServerSwitch';

describe('normalizeServerUrl', () => {
    it('normalizes http/https urls and strips trailing slashes', () => {
        expect(normalizeServerUrl(' https://Example.COM:8443/ ')).toBe('https://example.com:8443');
        expect(normalizeServerUrl('http://localhost:3012////')).toBe('http://localhost:3012');
        expect(normalizeServerUrl('https://example.com/path/')).toBe('https://example.com/path');
    });

    it('strips query and hash', () => {
        expect(normalizeServerUrl('https://example.com/path/?token=secret#frag')).toBe('https://example.com/path');
    });

    it('rejects non-http schemes and invalid urls', () => {
        expect(normalizeServerUrl('javascript:alert(1)')).toBe('');
        expect(normalizeServerUrl('file:///etc/passwd')).toBe('');
        expect(normalizeServerUrl('not a url')).toBe('');
        expect(normalizeServerUrl('')).toBe('');
    });
});

