import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

import { executeContributedAction } from './executeContributedAction';

function lazyTargetActionRegistry(
    onDemandActivation: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'],
): ResolvedExecutablePluginRuntimeRegistry {
    const action = {
        pluginId: 'acme.target',
        definition: {
            id: 'activate',
            surfaces: { cli: true },
        },
    } as unknown as ResolvedActionContribution;
    return {
        contributes: {
            actionsById: new Map([['acme.target/activate', action]]),
        },
        targetActionInvocations: {
            expects: () => true,
            has: () => false,
        },
        activateContributionsOnDemand: onDemandActivation,
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

describe('executeContributedAction lazy activation failures', () => {
    it('projects an unexpected activation rejection once before it reaches the public Action result', async () => {
        const secret = 'target-action-activation-secret';
        const path = '/Users/alice/private/target-action-activation.json';
        const activationMessage = `activation failed with ${secret} at ${path}: ${'🚫'.repeat(700)}`;
        const redaction = registerSensitiveDiagnosticValues([secret]);
        const registry = lazyTargetActionRegistry(async () => {
            throw new Error(activationMessage);
        });

        try {
            const attempt = await executeContributedAction({
                runtimeRegistry: registry,
                actionId: 'acme.target/activate',
                context: { surface: 'cli' },
            });

            expect(attempt).toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_activation_failed',
                    actionHandlerInvocation: 'notStarted',
                },
            });
            if (!attempt.matched || attempt.result.ok) {
                throw new Error('Expected a contributed Action activation failure');
            }
            expect(attempt.result.error).toBe(
                projectPluginFailureText(new Error(activationMessage)),
            );
            expect(attempt.result.error).not.toContain(secret);
            expect(attempt.result.error).not.toContain(path);
            expect(new TextEncoder().encode(attempt.result.error).byteLength)
                .toBeLessThanOrEqual(2_048);
        } finally {
            redaction.close();
        }
    });

    it('keeps a failed target settlement after the admitted generation retires', async () => {
        const action = {
            pluginId: 'acme.target',
            definition: {
                id: 'commit',
                surfaces: { cli: true },
            },
        } as unknown as ResolvedActionContribution;
        let current = true;
        const registry = {
            contributes: {
                actionsById: new Map([['acme.target/commit', action]]),
            },
            targetActionInvocations: {
                expects: () => true,
                has: () => true,
                invoke: async () => {
                    current = false;
                    return {
                        status: 'failed' as const,
                        code: 'fixture_effect_committed_failure',
                        message: 'target reported a known non-retryable failure',
                        retryable: false,
                        data: { durable: 'unknown-to-caller-but-settled' },
                    };
                },
            },
            resolveCurrentPluginImmutableGenerationId: async () => (
                current ? 'immutable-generation-1' : null
            ),
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            expectedContributorImmutableGenerationId: 'immutable-generation-1',
            context: { surface: 'cli' },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'fixture_effect_committed_failure',
                error: 'target reported a known non-retryable failure',
                retryable: false,
                data: { durable: 'unknown-to-caller-but-settled' },
            },
        });
    });

    it('emits outcome-unknown only when cancellation wins after target handler entry', async () => {
        const action = {
            pluginId: 'acme.target',
            definition: {
                id: 'commit',
                surfaces: { cli: true },
            },
        } as unknown as ResolvedActionContribution;
        const targetResults = [
            {
                status: 'unavailable' as const,
                code: 'plugin_action_aborted',
                message: 'caller cancelled after handler entry',
            },
            {
                status: 'unavailable' as const,
                code: 'plugin_action_aborted',
                message: 'caller cancelled before handler entry',
                actionHandlerInvocation: 'notStarted' as const,
            },
            {
                status: 'failed' as const,
                code: 'plugin_action_aborted',
                message: 'target settled a known failure with this code',
            },
        ];
        const registry = {
            contributes: {
                actionsById: new Map([['acme.target/commit', action]]),
            },
            targetActionInvocations: {
                expects: () => true,
                has: () => true,
                invoke: async () => targetResults.shift(),
            },
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: { surface: 'cli' },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_outcome_unknown',
                error: 'caller cancelled after handler entry',
            },
        });

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: { surface: 'cli' },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_aborted',
                error: 'caller cancelled before handler entry',
                actionHandlerInvocation: 'notStarted',
            },
        });

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: { surface: 'cli' },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_aborted',
                error: 'target settled a known failure with this code',
            },
        });
    });
});
