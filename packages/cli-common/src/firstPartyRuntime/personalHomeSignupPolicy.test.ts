import { describe, expect, it } from 'vitest';

import {
    applyPersonalHomeSignupClosure,
    applyAndVerifyPersonalHomeSignupClosure,
    assertPersonalHomeSignupClosed,
    readEffectivePersonalHomeSignupPolicy,
} from './personalHomeSignupPolicy.js';

describe('Personal Home signup policy', () => {
    it('re-applies anonymous-signup closure without dropping managed or operator env', () => {
        const rendered = applyPersonalHomeSignupClosure([
            'PORT=4311',
            'HAPPIER_SERVER_HOST=127.0.0.1',
            'AUTH_ANONYMOUS_SIGNUP_ENABLED=1',
            'CUSTOM_OPERATOR_SETTING=keep',
            '',
        ].join('\n'));

        expect(rendered).toContain('PORT=4311');
        expect(rendered).toContain('HAPPIER_SERVER_HOST=127.0.0.1');
        expect(rendered).toContain('CUSTOM_OPERATOR_SETTING=keep');
        expect(rendered.match(/^AUTH_ANONYMOUS_SIGNUP_ENABLED=.*$/gmu)).toEqual([
            'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        ]);
        expect(readEffectivePersonalHomeSignupPolicy(rendered)).toBe('disabled');
        expect(() => assertPersonalHomeSignupClosed(rendered)).not.toThrow();
    });

    it('replaces duplicate policy entries so a stale enabled value cannot win readback', () => {
        const rendered = applyPersonalHomeSignupClosure([
            'AUTH_ANONYMOUS_SIGNUP_ENABLED=1',
            '# AUTH_ANONYMOUS_SIGNUP_ENABLED=1',
            'AUTH_ANONYMOUS_SIGNUP_ENABLED=true',
        ].join('\n'));

        expect(rendered).toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
        expect(rendered).not.toMatch(/^AUTH_ANONYMOUS_SIGNUP_ENABLED=(?:1|true)$/gmu);
        expect(readEffectivePersonalHomeSignupPolicy(rendered)).toBe('disabled');
    });

    it('provides one reapply-and-verify step for runtime owners', () => {
        expect(applyAndVerifyPersonalHomeSignupClosure('PORT=4311\n')).toContain(
            'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        );
    });

    it('fails closed when policy readback is missing or enabled', () => {
        expect(readEffectivePersonalHomeSignupPolicy('PORT=4311\n')).toBe('unknown');
        expect(() => assertPersonalHomeSignupClosed('PORT=4311\n')).toThrow(
            'Personal Home signup closure could not be verified',
        );
        expect(readEffectivePersonalHomeSignupPolicy('AUTH_ANONYMOUS_SIGNUP_ENABLED=1\n')).toBe('enabled');
        expect(() => assertPersonalHomeSignupClosed('AUTH_ANONYMOUS_SIGNUP_ENABLED=1\n')).toThrow(
            'Personal Home signup closure could not be verified',
        );
    });

    it('accepts only explicit false values as disabled', () => {
        expect(readEffectivePersonalHomeSignupPolicy('AUTH_ANONYMOUS_SIGNUP_ENABLED=0\n')).toBe('disabled');
        expect(readEffectivePersonalHomeSignupPolicy('AUTH_ANONYMOUS_SIGNUP_ENABLED=false\n')).toBe('disabled');
        expect(readEffectivePersonalHomeSignupPolicy('AUTH_ANONYMOUS_SIGNUP_ENABLED=off\n')).toBe('disabled');
        expect(readEffectivePersonalHomeSignupPolicy('AUTH_ANONYMOUS_SIGNUP_ENABLED=yes\n')).toBe('enabled');
    });
});
