import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

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

/**
 * Mounted Plugin UI provenance fixtures: the daemon ingress derives this exact
 * caller only after matching the request's mounted binding against the live
 * registry lease, so a plugin-kind caller whose origin is the mounted UI
 * surface carries present-user UI authority, not plugin authority.
 */
function mountedUiCaller() {
    return {
        kind: 'plugin' as const,
        pluginId: 'acme.target',
        contribution: {
            id: 'dashboard',
            qualifiedId: 'acme.target/dashboard',
        },
        occurrenceId: 'acme-target-occurrence-1',
        sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'acme-target-generation-1',
            installSource: 'archive' as const,
        },
        materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.target' },
        originSurface: 'ui' as const,
    };
}

function surfacesRegistry(
    surfaces: Record<string, boolean>,
): ResolvedExecutablePluginRuntimeRegistry {
    const action = {
        pluginId: 'acme.target',
        definition: { id: 'commit', surfaces },
    } as unknown as ResolvedActionContribution;
    const invocations: Record<string, unknown>[] = [];
    return {
        contributes: {
            actionsById: new Map([['acme.target/commit', action]]),
        },
        targetActionInvocations: {
            expects: () => true,
            has: () => true,
            invoke: async (invocation: Record<string, unknown>) => {
                invocations.push(invocation);
                return { status: 'executed' as const, value: { committed: true } };
            },
        },
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

describe('executeContributedAction invocation-authority derivation', () => {
    it('forwards admitted requester Account custody into the target invocation seed', async () => {
        const requesterAccount = { marker: 'requester-account' } as unknown as import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
        const requesterContext = { savedSecretOperationContext: requesterAccount };
        const projection = Object.create(null);
        Object.defineProperty(projection, requesterActionContext, { value: requesterContext, enumerable: false });
        const authorization = { requesterAccountProjection: projection };
        let captured: Record<string, unknown> | undefined;
        const action = { pluginId: 'acme.target', definition: { id: 'commit', surfaces: { cli: true }, execution: { target: 'daemon' } } } as unknown as ResolvedActionContribution;
        const registry = {
            contributes: { actionsById: new Map([['acme.target/commit', action]]) },
            targetActionInvocations: {
                expects: () => true,
                has: () => true,
                invoke: async (invocation: Record<string, unknown>) => { captured = invocation; return { status: 'executed' as const, value: { committed: true } }; },
            },
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        await expect(executeContributedAction({
            runtimeRegistry: registry, actionId: 'acme.target/commit', input: {},
            approvalContext: { externalActionExecutionAuthorization: authorization } as never,
            context: { surface: 'cli' },
        })).resolves.toEqual({ matched: true, result: { ok: true, result: { committed: true } } });
        expect(captured?.requesterAccount).toBe(requesterAccount);
    });

    it('admits a mounted Plugin UI user press on a UI-declared target as UI authority', async () => {
        const registry = surfacesRegistry({ ui: true });
        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: {
                surface: 'ui',
                invocationSurface: 'ui',
                caller: mountedUiCaller(),
            },
        })).resolves.toEqual({
            matched: true,
            result: { ok: true, result: { committed: true } },
        });
    });

    it('refuses a mounted Plugin UI press that only the plugin declaration would admit', async () => {
        const registry = surfacesRegistry({ plugin: true });
        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: {
                surface: 'ui',
                invocationSurface: 'ui',
                caller: mountedUiCaller(),
            },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_unavailable',
                error: 'Plugin action is not available on the requested surface',
                actionHandlerInvocation: 'notStarted',
            },
        });
    });

    it('uses the host-stamped invocation surface when the target capability surface is plugin', async () => {
        const registry = surfacesRegistry({ plugin: true });
        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: {
                surface: 'plugin',
                invocationSurface: 'ui',
                caller: mountedUiCaller(),
                isMountedCallerCurrent: async () => true,
            },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_unavailable',
                error: 'Plugin action is not available on the requested surface',
                actionHandlerInvocation: 'notStarted',
            },
        });
    });

    it('keeps direct plugin invocation plugin-authority only and unable to claim UI', async () => {
        const pluginDeclared = surfacesRegistry({ plugin: true });
        await expect(executeContributedAction({
            runtimeRegistry: pluginDeclared,
            actionId: 'acme.target/commit',
            context: { surface: 'plugin' },
        })).resolves.toEqual({
            matched: true,
            result: { ok: true, result: { committed: true } },
        });

        const uiDeclared = surfacesRegistry({ ui: true });
        await expect(executeContributedAction({
            runtimeRegistry: uiDeclared,
            actionId: 'acme.target/commit',
            context: { surface: 'plugin' },
        })).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_unavailable',
                error: 'Plugin action is not available on the requested surface',
                actionHandlerInvocation: 'notStarted',
            },
        });
    });

    it('keeps background invocations on the plugin declaration and present-user intent off', async () => {
        const registry = surfacesRegistry({ plugin: true });
        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: { surface: 'background' },
        })).resolves.toEqual({
            matched: true,
            result: { ok: true, result: { committed: true } },
        });
    });
});

describe('executeContributedAction lazy activation failures', () => {
    it('captures the exact prepared target without invoking it during contributed admission', async () => {
        const action = {
            pluginId: 'acme.target',
            definition: {
                id: 'commit',
                surfaces: { cli: true },
                title: 'Commit',
                execution: { target: 'daemon' },
                operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
            },
        } as unknown as ResolvedActionContribution;
        const run = vi.fn(async () => ({
            status: 'executed' as const,
            value: { committed: true },
        }));
        const prepare = vi.fn(async () => ({ kind: 'ready' as const, run }));
        const invoke = vi.fn();
        const registry = {
            contributes: {
                actionsById: new Map([['acme.target/commit', action]]),
            },
            targetActionInvocations: {
                expects: () => true,
                has: () => true,
                prepare,
                invoke,
            },
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        let captured: Parameters<HostActionOperationRuntime['observePluginExecution']>[0]['execute'] | undefined;

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: {
                surface: 'cli',
                observePluginExecution: async ({ execute }) => {
                    captured = execute;
                    return { ok: true, result: null };
                },
            },
        })).resolves.toEqual({
            matched: true,
            result: { ok: true, result: null },
        });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        await expect(captured?.({ signal: new AbortController().signal, operationProgress: { update() {} } }))
            .resolves.toEqual({ ok: true, result: { committed: true } });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('passes the tracked operation progress port to the committed target invocation', async () => {
        const action = {
            pluginId: 'acme.target',
            definition: {
                id: 'commit',
                surfaces: { cli: true },
            },
        } as unknown as ResolvedActionContribution;
        const invoke = vi.fn(async () => ({
            status: 'executed' as const,
            value: { committed: true },
        }));
        const registry = {
            contributes: {
                actionsById: new Map([['acme.target/commit', action]]),
            },
            targetActionInvocations: {
                expects: () => true,
                has: () => true,
                invoke,
            },
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const operationProgress = { update: vi.fn() };

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            context: { surface: 'cli', operationProgress },
        })).resolves.toEqual({
            matched: true,
            result: { ok: true, result: { committed: true } },
        });
        expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ operationProgress }));
    });

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

    it('keeps a failed target settlement after the admitted occurrence retires', async () => {
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
            readPluginOccurrenceId: () => current ? 'occurrence-1' : null,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;

        await expect(executeContributedAction({
            runtimeRegistry: registry,
            actionId: 'acme.target/commit',
            expectedContributorOccurrenceId: 'occurrence-1',
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
