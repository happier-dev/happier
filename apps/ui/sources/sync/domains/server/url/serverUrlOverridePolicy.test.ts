import { describe, expect, it } from 'vitest';

import { resolveEffectiveServerUrlOverride } from './serverUrlOverridePolicy';

describe('resolveEffectiveServerUrlOverride', () => {
    it('rejects a different loopback server by default to protect cross-device scans', () => {
        expect(resolveEffectiveServerUrlOverride({
            requestedServerUrl: 'http://127.0.0.1:40003',
            activeServerUrl: 'http://127.0.0.1:22941',
        })).toBeNull();
    });

    it('allows a different loopback server when the caller is a same-browser connect route', () => {
        expect(resolveEffectiveServerUrlOverride({
            requestedServerUrl: 'http://127.0.0.1:40003',
            activeServerUrl: 'http://127.0.0.1:22941',
            allowLoopbackOverride: true,
        })).toBe('http://127.0.0.1:40003');
    });
});
