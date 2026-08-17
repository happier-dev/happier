import { describe, expect, it } from 'vitest';

import { isLoopbackHostedWebUrl } from './HostedPluginTargetSecurity';

describe('HostedPluginTargetSecurity', () => {
    it('recognizes bracketed IPv6 loopback URLs', () => {
        expect(isLoopbackHostedWebUrl('http://[::1]:5173/')).toBe(true);
        expect(isLoopbackHostedWebUrl('http://[::ffff:127.0.0.1]:5173/')).toBe(true);
        expect(isLoopbackHostedWebUrl('http://[::ffff:192.0.2.1]:5173/')).toBe(false);
    });
});
