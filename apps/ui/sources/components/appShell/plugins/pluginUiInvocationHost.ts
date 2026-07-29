import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    PluginCancellationOptions,
    PluginReference,
} from '@happier-dev/plugin-sdk/runtime';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type PluginJsonValueV2,
} from '@happier-dev/protocol';

import {
    machinePluginStructuredMessageActionExecute,
    type MachinePluginStructuredMessageActionResult,
} from '@/sync/ops/machineContributionRegistryProjection';

export type AppShellPluginUiActionExecute = (
    machineId: string,
    opts: Parameters<typeof machinePluginStructuredMessageActionExecute>[1],
) => Promise<MachinePluginStructuredMessageActionResult>;

const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000;

function invocationError(
    code: string,
    identity: Readonly<{ pluginId: string; contributionId: string; generation: string }>,
): PluginError {
    return new PluginError({
        code,
        details: {
            pluginId: identity.pluginId,
            contributionId: identity.contributionId,
            generation: identity.generation,
        },
    });
}

function qualifyAction(pluginId: string, action: PluginReference): string {
    const identity = typeof action === 'string'
        ? createPluginContributionIdentity({ pluginId, localId: action })
        : createPluginContributionIdentity(action);
    return buildQualifiedPluginContributionKey(identity);
}

function composeOperationSignal(
    invocationSignal: AbortSignal,
    operationSignal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
    if (!operationSignal || operationSignal === invocationSignal) {
        return Object.freeze({ signal: invocationSignal, dispose() {} });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (invocationSignal.aborted || operationSignal.aborted) controller.abort();
    else {
        invocationSignal.addEventListener('abort', abort, { once: true });
        operationSignal.addEventListener('abort', abort, { once: true });
    }
    return Object.freeze({
        signal: controller.signal,
        dispose() {
            invocationSignal.removeEventListener('abort', abort);
            operationSignal.removeEventListener('abort', abort);
        },
    });
}

/**
 * AppShell-owned producer for non-mounted plugin UI operations.
 *
 * It deliberately delegates executable work to the daemon action front door,
 * where the canonical invocation context, policy evaluator, and service factory
 * remain the only owners. All other UI methods fail closed because there is no
 * mounted surface or presentation target in this lifecycle.
 */
export function createAppShellPluginUiInvocationHost(input: Readonly<{
    pluginId: string;
    contributionId: string;
    generation: string;
    machineId: string;
    serverId?: string | null;
    signal: AbortSignal;
    timeoutMs?: number;
    isCurrent(): boolean;
    execute?: AppShellPluginUiActionExecute;
}>): PluginUiHostApi {
    const identity = Object.freeze({
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        generation: input.generation,
    });
    const unavailable = (): never => {
        throw invocationError('plugin_ui_method_unavailable', identity);
    };
    const execute = input.execute ?? machinePluginStructuredMessageActionExecute;

    return Object.freeze({
        version: () => Object.freeze({
            apiVersion: '1.0.0',
            wireVersion: 1,
            methods: Object.freeze(['executeAction'] as const),
        }),
        context: async () => unavailable(),
        watchContext: unavailable,
        async executeAction(
            action: PluginReference,
            actionInput: JsonValue,
            options?: PluginCancellationOptions,
        ) {
            const operation = composeOperationSignal(input.signal, options?.signal);
            try {
                if (operation.signal.aborted) throw invocationError('plugin_ui_invocation_aborted', identity);
                if (!input.isCurrent()) throw invocationError('plugin_ui_generation_retired', identity);
                const result = await execute(input.machineId, {
                    serverId: input.serverId ?? null,
                    expectedGeneration: input.generation,
                    qualifiedActionId: qualifyAction(input.pluginId, action),
                    // The SDK makes JSON containers readonly for authors while
                    // Protocol's equivalent recursive JSON type is mutable.
                    // The RPC owner immediately schema-parses this same value.
                    input: actionInput as PluginJsonValueV2,
                    executionSurface: 'ui',
                    timeoutMs: input.timeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS,
                    signal: operation.signal,
                });
                let errorCode: string;
                if (!result.supported) {
                    errorCode = 'plugin_ui_action_host_unavailable';
                } else if (!result.result.ok) {
                    errorCode = result.result.code;
                } else {
                    // The daemon response is the canonical action settlement. Once
                    // it reports success, a later local abort or generation
                    // observation must not hide an outward result already known.
                    return result.result.result as JsonValue;
                }
                if (operation.signal.aborted) throw invocationError('plugin_ui_invocation_aborted', identity);
                if (!input.isCurrent()) throw invocationError('plugin_ui_generation_retired', identity);
                throw invocationError(errorCode, identity);
            } finally {
                operation.dispose();
            }
        },
        readResource: async () => unavailable(),
        watchResource: unavailable,
        openSurface: async () => unavailable(),
        diagnostic: () => {},
        readClipboard: async () => unavailable(),
        writeClipboard: async () => unavailable(),
        openExternalLink: async () => unavailable(),
    });
}
