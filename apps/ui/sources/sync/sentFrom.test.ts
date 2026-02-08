import { describe, expect, it } from 'vitest';

import { resolveSentFromForEnvironment } from './sentFrom';

describe('sentFrom', () => {
    it('returns web for web platform', () => {
        expect(resolveSentFromForEnvironment({ platformOs: 'web', runningOnMac: false })).toBe('web');
    });

    it('returns android for android platform', () => {
        expect(resolveSentFromForEnvironment({ platformOs: 'android', runningOnMac: false })).toBe('android');
    });

    it('returns ios for ios platform when not running on mac', () => {
        expect(resolveSentFromForEnvironment({ platformOs: 'ios', runningOnMac: false })).toBe('ios');
    });

    it('returns mac for ios platform when running on mac', () => {
        expect(resolveSentFromForEnvironment({ platformOs: 'ios', runningOnMac: true })).toBe('mac');
    });

    it('falls back to web for unknown platform', () => {
        expect(resolveSentFromForEnvironment({ platformOs: 'windows', runningOnMac: false })).toBe('web');
    });
});

