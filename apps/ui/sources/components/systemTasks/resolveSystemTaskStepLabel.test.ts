import { describe, expect, it } from 'vitest';

import { resolveSystemTaskStepLabel } from './resolveSystemTaskStepLabel';

describe('resolveSystemTaskStepLabel', () => {
    it('returns null when step id is null', () => {
        expect(resolveSystemTaskStepLabel(null)).toBeNull();
    });

    it('translates known remote SSH step ids', () => {
        expect(resolveSystemTaskStepLabel('ssh.trust')).not.toBe('ssh.trust');
    });

    it('translates known relay drift repair step ids', () => {
        expect(resolveSystemTaskStepLabel('relay.drift.repair.start')).not.toBe('relay.drift.repair.start');
    });

    it('translates known Tailscale secure access step ids', () => {
        expect(resolveSystemTaskStepLabel('tailscale.serveEnable')).not.toBe('tailscale.serveEnable');
        expect(resolveSystemTaskStepLabel('tailscale.verifyUrl')).not.toBe('tailscale.verifyUrl');
    });

    it('returns null for unknown step ids', () => {
        expect(resolveSystemTaskStepLabel('unknown.step.id')).toBe('unknown.step.id');
    });
});
