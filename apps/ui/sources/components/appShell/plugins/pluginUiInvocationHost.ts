import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    PluginCancellationOptions,
    PluginReference,
} from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginUiExecuteActionRequestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { machinePluginStructuredMessageActionExecute } from '@/sync/ops/machineContributionRegistryProjection';

export type AppShellPluginUiActionExecute = (
    machineId: string,
    opts: Parameters<typeof machinePluginStructuredMessageActionExecute>[1],
) => Promise<Awaited<ReturnType<typeof machinePluginStructuredMessageActionExecute>>>;

/** The app-shell owner bounds every present-user plugin invocation to this lifetime. */
export const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000;

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

export function composeAppShellInvocationSignal(
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
 * AppShell-owned producer for non-mounted plugin UI operations (Voice).
 *
 * It is a **thin adapter over the canonical dispatcher** (plan §3.5): it owns
 * only transport plumbing — composing the caller's cancellation signal with the
 * invocation signal and shaping the failure as a public `PluginError`. It
 * contains no independent action parsing, policy evaluation, currentness
 * decision or result interpretation. All other UI methods fail closed because
 * there is no mounted surface or presentation target in this lifecycle.
 */
export function createAppShellPluginUiInvocationHost(input: Readonly<{
    pluginId: string;
    contributionId: string;
    generation: string;
    machineId: string;
    serverId?: string | null;
    /** Exact projection-origin binding for this mounted Voice contribution. */
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
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
    const executeAction = async (
        action: PluginReference,
        actionInput: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<JsonValue> => {
        const operation = composeAppShellInvocationSignal(input.signal, options?.signal);
        try {
            const materialization = input.executionOrigin?.materializationRef;
            const mountedBinding = materialization
                && materialization.pluginId === input.pluginId
                && materialization.machineId === input.machineId
                ? Object.freeze({
                    contributionLocalId: input.contributionId,
                    materializationRef: materialization,
                })
                : null;
            const actionRequest = PluginUiExecuteActionRequestV1Schema.safeParse({
                action,
                input: actionInput,
            });
            if (!actionRequest.success) {
                throw invocationError('plugin_surface_action_reference_invalid', identity);
            }
            const outcome = await dispatchPluginSurfaceAction({
                callerPluginId: input.pluginId,
                callerContributionLocalId: input.contributionId,
                ...(mountedBinding ? { callerBinding: mountedBinding } : {}),
                action: actionRequest.data.action,
                input: actionRequest.data.input ?? null,
                contributedAction: {
                    machineId: input.machineId,
                    serverId: input.serverId ?? null,
                    expectedGeneration: input.generation,
                    timeoutMs: input.timeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS,
                    ...(input.execute
                        ? { execute: input.execute as PluginSurfaceContributedActionTransport }
                        : {}),
                },
                signal: operation.signal,
                isCurrent: input.isCurrent,
            });
            if (!outcome.ok) throw invocationError(outcome.reason, identity);
            return outcome.result as JsonValue;
        } finally {
            operation.dispose();
        }
    };

    return Object.freeze({
        version: () => Object.freeze({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: 1,
            methods: Object.freeze(['executeAction'] as const),
        }),
        context: async () => unavailable(),
        watchContext: unavailable,
        watchResource: async () => unavailable(),
        activeComposer: async () => unavailable(),
        readComposer: async () => unavailable(),
        watchComposer: async () => unavailable(),
        applyComposer: async () => unavailable(),
        focusComposer: async () => unavailable(),
        setComposerDecorations: async () => unavailable(),
        acquireComposerInputLock: async () => unavailable(),
        pickComposerMedia: async () => unavailable(),
        inspectComposerContent: async () => unavailable(),
        releaseComposerContent: async () => unavailable(),
        selectActionInput: async () => unavailable(),
        executeAction: executeAction as PluginUiHostApi['executeAction'],
        readResource: async () => unavailable(),
        statOpenableContent: async () => unavailable(),
        readOpenableContent: async () => unavailable(),
        openSurface: async () => unavailable(),
        replacePageLocation: async () => unavailable(),
        notify: async () => unavailable(),
        confirm: async () => unavailable(),
        diagnostic: () => {},
        readClipboard: async () => unavailable(),
        writeClipboard: async () => unavailable(),
        openExternalLink: async () => unavailable(),
    });
}
