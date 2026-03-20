import { describe, expect, it } from 'vitest';

import {
    getAllowedManagedServiceLifecycleTransitions,
    validateManagedServiceLifecycleTransition,
} from './managedServiceLifecycle';

describe('managedServiceLifecycle', () => {
    it('returns the canonical next states for each lifecycle stage', () => {
        expect(getAllowedManagedServiceLifecycleTransitions('stopped')).toEqual(['starting']);
        expect(getAllowedManagedServiceLifecycleTransitions('starting')).toEqual([
            'running',
            'degraded',
            'stopping',
            'stopped',
            'crashed',
        ]);
        expect(getAllowedManagedServiceLifecycleTransitions('running')).toEqual(['degraded', 'stopping', 'crashed']);
        expect(getAllowedManagedServiceLifecycleTransitions('degraded')).toEqual(['running', 'stopping', 'crashed']);
        expect(getAllowedManagedServiceLifecycleTransitions('stopping')).toEqual(['stopped', 'crashed']);
        expect(getAllowedManagedServiceLifecycleTransitions('crashed')).toEqual(['starting', 'stopped']);
    });

    it('accepts valid transitions that model normal recovery and shutdown flows', () => {
        expect(validateManagedServiceLifecycleTransition({ from: 'stopped', to: 'starting' })).toEqual({
            allowed: true,
            reason: null,
        });

        expect(validateManagedServiceLifecycleTransition({ from: 'degraded', to: 'running' })).toEqual({
            allowed: true,
            reason: null,
        });

        expect(validateManagedServiceLifecycleTransition({ from: 'crashed', to: 'starting' })).toEqual({
            allowed: true,
            reason: null,
        });
    });

    it('rejects self-transitions explicitly', () => {
        expect(validateManagedServiceLifecycleTransition({ from: 'running', to: 'running' })).toEqual({
            allowed: false,
            reason: 'same_state',
        });
    });

    it('rejects transitions outside the canonical lifecycle graph', () => {
        expect(validateManagedServiceLifecycleTransition({ from: 'stopped', to: 'running' })).toEqual({
            allowed: false,
            reason: 'invalid_transition',
        });

        expect(validateManagedServiceLifecycleTransition({ from: 'stopping', to: 'starting' })).toEqual({
            allowed: false,
            reason: 'invalid_transition',
        });
    });
});
