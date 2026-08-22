import {
    redactBugReportSensitiveText,
    registerSensitiveDiagnosticValues,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

import {
    classifyNativeAgentSessionEffectBoundaryError,
    createNativeAgentSessionEffectBoundaryError,
    NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE,
    NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE,
    projectNativeAgentSessionHostServiceError,
    sanitizeNativeAgentSessionBoundaryError,
} from './nativeAgentSessionBoundaryError';

describe('native Agent session boundary error sanitization', () => {
    it('distinguishes retryable pre-effect authority loss from non-replayable outcome ambiguity', () => {
        const unavailable = createNativeAgentSessionEffectBoundaryError(
            'authority_unavailable_before_effect',
        );
        expect(unavailable).toMatchObject({
            code:
                NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE,
            retryable: true,
        });
        expect(
            classifyNativeAgentSessionEffectBoundaryError(unavailable),
        ).toBe('authority_unavailable_before_effect');

        const outcomeUnknown = createNativeAgentSessionEffectBoundaryError(
            'outcome_unknown_after_dispatch',
        );
        expect(outcomeUnknown).toMatchObject({
            code: NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE,
            retryable: false,
        });
        expect(
            classifyNativeAgentSessionEffectBoundaryError(
                outcomeUnknown,
            ),
        ).toBe('outcome_unknown_after_dispatch');
    });

    it('preserves safe own string codes without invoking accessors or Proxy get traps', () => {
        const secret = 'native-boundary-secret';
        const redaction = registerSensitiveDiagnosticValues([secret]);
        try {
            let codeReads = 0;
            const dataError = Object.assign(
                new Error(`native open failed: ${secret}`),
                { code: `native_open_failed:${secret}` },
            );
            const sanitizedData = sanitizeNativeAgentSessionBoundaryError(
                dataError,
                true,
            ) as Error & { code?: string };
            expect(sanitizedData.message).toBe(
                'native open failed: [REDACTED]',
            );
            expect(sanitizedData.code).toBe(
                'native_open_failed:[REDACTED]',
            );

            const accessorError = new Error(`accessor failed: ${secret}`);
            Object.defineProperty(accessorError, 'code', {
                get() {
                    codeReads += 1;
                    throw new Error('error code accessor must not execute');
                },
            });
            const sanitizedAccessor = sanitizeNativeAgentSessionBoundaryError(
                accessorError,
                true,
            ) as Error & { code?: string };
            expect(sanitizedAccessor.message).toBe(
                'accessor failed: [REDACTED]',
            );
            expect(sanitizedAccessor.code).toBeUndefined();

            const proxyTarget = Object.assign(
                new Error(`proxy failed: ${secret}`),
                { code: `native_proxy_failed:${secret}` },
            );
            const proxyError = new Proxy(proxyTarget, {
                get(target, property, receiver) {
                    if (property === 'code') {
                        codeReads += 1;
                        throw new Error(
                            'error code Proxy trap must not execute',
                        );
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            const sanitizedProxy = sanitizeNativeAgentSessionBoundaryError(
                proxyError,
                true,
            ) as Error & { code?: string };
            expect(sanitizedProxy.message).toBe(
                'proxy failed: [REDACTED]',
            );
            expect(sanitizedProxy.code).toBe(
                'native_proxy_failed:[REDACTED]',
            );
            expect(codeReads).toBe(0);
        } finally {
            redaction.close();
        }
        expect(redactBugReportSensitiveText(secret)).toBe(secret);
    });

    it('keeps a PluginError from another SDK copy typed after redaction', () => {
        const secret = 'plugin-session-boundary-secret';
        const redaction = registerSensitiveDiagnosticValues([secret]);
        try {
            const foreignPluginError = Object.assign(
                new Error(`native open failed: ${secret}`),
                {
                    name: 'PluginError',
                    code: 'plugin_generation_stale',
                    retryable: true,
                    data: {
                        name: 'PluginError' as const,
                        code: 'plugin_generation_stale',
                        message: `native open failed: ${secret}`,
                        retryable: true,
                        details: { accountId: 'acct_1' },
                        remediation: { kind: 'retry' as const },
                        diagnostics: [{
                            code: 'plugin_generation_stale',
                            severity: 'warning' as const,
                            message: 'The plugin generation was replaced.',
                        }],
                    },
                },
            );
            expect(foreignPluginError).not.toBeInstanceOf(PluginError);

            const sanitized = sanitizeNativeAgentSessionBoundaryError(
                foreignPluginError,
                true,
            );

            expect(sanitized).toBeInstanceOf(PluginError);
            expect(isPluginError(sanitized)).toBe(true);
            expect(sanitized).toMatchObject({
                name: 'PluginError',
                code: 'plugin_generation_stale',
                retryable: true,
                message: 'native open failed: [REDACTED]',
                details: { accountId: 'acct_1' },
                remediation: { kind: 'retry' },
                diagnostics: [{
                    code: 'plugin_generation_stale',
                    severity: 'warning',
                    message: 'The plugin generation was replaced.',
                }],
            });
        } finally {
            redaction.close();
        }
    });

    it('preserves a PluginError from another SDK copy at the public host-services boundary', () => {
        const foreignPluginError = Object.assign(
            new Error('The plugin generation was replaced.'),
            {
                name: 'PluginError',
                code: 'plugin_generation_stale',
                retryable: true,
                data: {
                    name: 'PluginError' as const,
                    code: 'plugin_generation_stale',
                    message: 'The plugin generation was replaced.',
                    retryable: true,
                    details: { generation: 4 },
                },
            },
        );

        const projected = projectNativeAgentSessionHostServiceError(foreignPluginError);

        expect(projected).toBe(foreignPluginError);
        expect(isPluginError(projected)).toBe(true);
    });

    it('bounds plugin failure message, stack, and opaque code without replacing stable PluginError codes', () => {
        const secret = 'native-boundary-oversized-secret';
        const path = '/Users/alice/private/native-agent-session.json';
        const message = `native open failed with ${secret} at ${path}: ${'🚫'.repeat(700)}`;
        const stack = `PluginError: ${message}\n    at ${path}:1:1\n${'frame'.repeat(700)}`;
        const opaqueCode = `native_open_failed:${secret}:${path}:${'code'.repeat(700)}`;
        const redaction = registerSensitiveDiagnosticValues([secret]);
        try {
            const typed = new PluginError({
                code: 'plugin_generation_stale',
                message,
                retryable: true,
            });
            typed.stack = stack;
            const sanitizedTyped = sanitizeNativeAgentSessionBoundaryError(
                typed,
                true,
            );

            expect(sanitizedTyped).toBeInstanceOf(PluginError);
            expect(isPluginError(sanitizedTyped)).toBe(true);
            expect(sanitizedTyped).toMatchObject({
                code: 'plugin_generation_stale',
                retryable: true,
                message: projectPluginFailureText(new Error(message)),
                stack: projectPluginFailureText(new Error(stack)),
            });
            const typedError = sanitizedTyped as PluginError;
            expect(new TextEncoder().encode(typedError.message).byteLength)
                .toBeLessThanOrEqual(2_048);
            expect(new TextEncoder().encode(typedError.stack ?? '').byteLength)
                .toBeLessThanOrEqual(2_048);
            expect(typedError.message).not.toContain(secret);
            expect(typedError.message).not.toContain(path);
            expect(typedError.stack).not.toContain(secret);
            expect(typedError.stack).not.toContain(path);

            const opaqueCodeError = Object.assign(new Error('native open failed'), {
                code: opaqueCode,
            });
            const sanitizedCode = sanitizeNativeAgentSessionBoundaryError(
                opaqueCodeError,
                true,
            ) as Error & { code?: string };
            expect(sanitizedCode.code).toBe(
                projectPluginFailureText(new Error(opaqueCode)),
            );
            expect(sanitizedCode.code).not.toContain(secret);
            expect(sanitizedCode.code).not.toContain(path);
            expect(new TextEncoder().encode(sanitizedCode.code ?? '').byteLength)
                .toBeLessThanOrEqual(2_048);

            const sanitizedNonError = sanitizeNativeAgentSessionBoundaryError(
                `${message} ${'untrusted'.repeat(700)}`,
                true,
            ) as Error;
            expect(sanitizedNonError.message).toBe(
                projectPluginFailureText(`${message} ${'untrusted'.repeat(700)}`),
            );
        } finally {
            redaction.close();
        }
    });
});
