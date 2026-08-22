import { describe, expect, it } from 'vitest';

import { isPluginError, PluginError } from './errors.js';

describe('isPluginError', () => {
    it('recognizes the public fields produced by PluginError construction', () => {
        expect(isPluginError(new PluginError({
            code: 'target_unavailable',
            message: 'Target is unavailable',
            retryable: true,
        }))).toBe(true);
        expect(isPluginError(new PluginError({
            code: 'target_unavailable',
        }))).toBe(true);
    });

    it('rejects Error lookalikes that violate PluginError construction semantics', () => {
        const ordinaryError = Object.assign(new Error('Target is unavailable'), {
            code: 'target_unavailable',
            retryable: true,
            data: {
                name: 'PluginError',
                code: 'target_unavailable',
                message: 'Target is unavailable',
                retryable: true,
            },
        });
        const mismatchedMessage = Object.assign(new Error('A different message'), {
            name: 'PluginError',
            code: 'target_unavailable',
            retryable: true,
            data: {
                name: 'PluginError',
                code: 'target_unavailable',
                message: 'Target is unavailable',
                retryable: true,
            },
        });
        const implicitRetryableMismatch = Object.assign(new Error('target_unavailable'), {
            name: 'PluginError',
            code: 'target_unavailable',
            retryable: true,
            data: {
                name: 'PluginError',
                code: 'target_unavailable',
            },
        });

        expect(isPluginError(ordinaryError)).toBe(false);
        expect(isPluginError(mismatchedMessage)).toBe(false);
        expect(isPluginError(implicitRetryableMismatch)).toBe(false);
    });
});

describe('PluginError', () => {
    it('fails a subclass that renames the error instead of silently losing recognition', () => {
        class RenamedPluginError extends PluginError {
            constructor() {
                super({ code: 'renamed_subclass' });
                this.name = 'RenamedPluginError';
            }
        }

        expect(() => new RenamedPluginError()).toThrow(TypeError);
        expect(isPluginError(new PluginError({ code: 'renamed_subclass' }))).toBe(true);
    });
});
