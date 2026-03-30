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
});

