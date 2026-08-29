import { describe, expect, it } from 'vitest';

import {
    isPluginActionHandlerInvocationNotStartedAdvisory,
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

    it('does not let author constructor data add the host-reported marker', () => {
        const error = new PluginError({
            code: 'author_failure_after_effect',
            actionHandlerInvocation: 'notStarted',
        } as never);

        expect(error).not.toHaveProperty('actionHandlerInvocation');
        expect(error.data).not.toHaveProperty('actionHandlerInvocation');
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(error)).toBe(false);
    });

    it('treats a structurally added marker as advisory rather than provenance', () => {
        const error = new PluginError({ code: 'author_failure' });
        (error.data as Record<string, unknown>).actionHandlerInvocation = 'notStarted';

        // The public data carrier is intentionally structural for cross-bundle
        // interoperability. This recognizer can report the marker, but only
        // the canonical Action transport can establish whether a handler ran.
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(error)).toBe(true);
    });
});

describe('isPluginActionHandlerInvocationNotStartedAdvisory', () => {
    it('recognizes the host-reported marker while leaving provenance to Action transport', () => {
        const canonical = createPluginActionHandlerNotStartedError({
            code: 'plugin_action_unavailable',
        });
        // An incomplete lookalike does not satisfy the structural PluginError
        // contract. This is shape validation, not provenance validation.
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

        expect(isPluginActionHandlerInvocationNotStartedAdvisory(canonical)).toBe(true);
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(impostor)).toBe(false);
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(impostorError)).toBe(false);
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(startedCanonical)).toBe(false);
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(new Error('boom'))).toBe(false);
    });

    it('accepts a separately bundled SDK copy as an advisory structural contract', () => {
        const canonical = createPluginActionHandlerNotStartedError({
            code: 'plugin_action_unavailable',
        });
        // A second SDK copy in the same realm produces the identical public
        // shape without sharing this module's class identity. The same shape
        // can be authored by trusted code, so this remains advisory.
        const otherCopy = Object.assign(new Error(canonical.message), {
            name: 'PluginError',
            code: canonical.code,
            retryable: canonical.retryable,
            data: { ...canonical.data },
        });

        expect(isPluginError(otherCopy)).toBe(true);
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(otherCopy)).toBe(true);
    });

    it('does not treat a forged complete structural shape as provenance', () => {
        const forged = Object.assign(new Error('plugin_action_unavailable'), {
            name: 'PluginError',
            code: 'plugin_action_unavailable',
            retryable: false,
            data: {
                name: 'PluginError',
                code: 'plugin_action_unavailable',
                actionHandlerInvocation: 'notStarted',
            },
            actionHandlerInvocation: 'notStarted',
        });

        // Structural recognition intentionally accepts this trusted-code
        // shape. The result is only an advisory marker; callers must not use
        // it as standalone evidence that an effect did not run.
        expect(isPluginActionHandlerInvocationNotStartedAdvisory(forged)).toBe(true);
    });
});
