import { describe, expect, it } from 'vitest';

import {
    isPluginActionHandlerInvocationKnownNotStarted,
    isPluginError,
    PluginError,
} from './errors.js';
import { createPluginActionHandlerNotStartedError } from './host/registration/index.js';

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

    it('does not let author constructor data mint the host-only not-started fact', () => {
        const error = new PluginError({
            code: 'author_failure_after_effect',
            actionHandlerInvocation: 'notStarted',
        } as never);

        expect(error).not.toHaveProperty('actionHandlerInvocation');
        expect(error.data).not.toHaveProperty('actionHandlerInvocation');
        expect(isPluginActionHandlerInvocationKnownNotStarted(error)).toBe(false);
    });
});

describe('isPluginActionHandlerInvocationKnownNotStarted', () => {
    it('proves the not-started claim only through the canonical PluginError contract', () => {
        const canonical = createPluginActionHandlerNotStartedError({
            code: 'plugin_action_unavailable',
        });
        // A plain object may name itself `PluginError` and claim the handler
        // never ran. Believing it would let a retry duplicate an effect that
        // did run, so recognition must go through the canonical contract.
        const impostor = {
            name: 'PluginError',
            code: 'plugin_action_unavailable',
            actionHandlerInvocation: 'notStarted',
        };
        const impostorError = Object.assign(new Error('plugin_action_unavailable'), {
            name: 'PluginError',
            code: 'plugin_action_unavailable',
            // No `retryable`/`data` consistency: not the canonical contract.
            actionHandlerInvocation: 'notStarted',
        });
        const startedCanonical = new PluginError({ code: 'plugin_action_unavailable' });

        expect(isPluginActionHandlerInvocationKnownNotStarted(canonical)).toBe(true);
        expect(isPluginActionHandlerInvocationKnownNotStarted(impostor)).toBe(false);
        expect(isPluginActionHandlerInvocationKnownNotStarted(impostorError)).toBe(false);
        expect(isPluginActionHandlerInvocationKnownNotStarted(startedCanonical)).toBe(false);
        expect(isPluginActionHandlerInvocationKnownNotStarted(new Error('boom'))).toBe(false);
    });

    it('accepts a separately bundled SDK copy of the same canonical contract', () => {
        const canonical = createPluginActionHandlerNotStartedError({
            code: 'plugin_action_unavailable',
        });
        // A second SDK copy in the same realm produces the identical public
        // shape without sharing this module's class identity.
        const otherCopy = Object.assign(new Error(canonical.message), {
            name: 'PluginError',
            code: canonical.code,
            retryable: canonical.retryable,
            data: { ...canonical.data },
        });

        expect(isPluginError(otherCopy)).toBe(true);
        expect(isPluginActionHandlerInvocationKnownNotStarted(otherCopy)).toBe(true);
    });
});
