import { describe, expect, it } from 'vitest';
import { resolveSecurityFlowAnimation } from './SelfHostSecurity';

describe('SelfHostSecurity', () => {
    it('disables the relay flow animation when reduced motion is requested', () => {
        expect(resolveSecurityFlowAnimation(true)).toBe(null);
    });

    it('keeps the relay flow animation enabled for normal motion', () => {
        expect(resolveSecurityFlowAnimation(false)).toEqual({
            durationSeconds: 3,
            repeatCount: 'indefinite',
        });
    });
});
