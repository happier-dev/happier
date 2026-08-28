import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    PluginCancellationOptions,
    PluginReference,
} from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginUiExecuteActionRequestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginActionCurrentIntentHandler,
} from '@/components/plugins/surfaces/pluginSurfaceFeedback';
import type { PluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { machinePluginStructuredMessageActionExecute } from '@/sync/ops/machineContributionRegistryProjection';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

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
    /** Current raw V2 Action lookup supplied by the projection owner. */
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    /** Reads the AppShell's incumbent destination binding at Action invocation time. */
    readNavigationBinding?: () => PluginSurfaceDestinationNavigationBinding | null | undefined;
    signal: AbortSignal;
    timeoutMs?: number;
    isCurrent(): boolean;
    execute?: AppShellPluginUiActionExecute;
    /** Admitted UI projection; resolves declared confirmation wording. */
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): PluginUiHostApi {
    const identity = Object.freeze({
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        generation: input.generation,
    });
    // Projection generations are decimal wire values at this Voice-host seam.
    // The shared client Action dispatcher accepts only its exact non-negative
    // numeric generation, so malformed/stale host input cannot manufacture a
    // client executable binding. Daemon Actions retain their incumbent path.
    const projectionGeneration = Number(input.generation);
    const requestCurrentIntent = createPluginActionCurrentIntentHandler({
        requester: {
            pluginId: input.pluginId,
            contributionId: input.contributionId,
            generationId: input.generation,
            invocationId: `voice:${input.contributionId}`,
        },
        signal: input.signal,
        isCurrent: input.isCurrent,
        pluginUiProjection: input.pluginUiProjection,
    });
    const clientActionOpenSurface: PluginSurfaceDestinationNavigationBinding['openSurface'] | undefined = input.readNavigationBinding
        ? (request) => {
            const binding = input.readNavigationBinding?.();
            return binding
                ? binding.openSurface(request)
                : { ok: false, code: 'unavailable', reason: 'plugin_surface_open_unavailable' };
        }
        : undefined;
    const clientAction = Number.isSafeInteger(projectionGeneration) && projectionGeneration >= 0
        ? Object.freeze({
            projectionGeneration,
            requestCurrentIntent,
            ...(clientActionOpenSurface ? { openSurface: clientActionOpenSurface } : {}),
        })
        : null;
    const unavailable = (): never => {
        throw invocationError('plugin_ui_method_unavailable', identity);
    };
    const executeAction = async (
        action: PluginReference,
        actionInput?: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<JsonValue> => {
        const operation = composeAppShellInvocationSignal(input.signal, options?.signal);
        try {
            const actionRequest = PluginUiExecuteActionRequestV1Schema.safeParse({
                action,
                ...(actionInput === undefined ? {} : { input: actionInput }),
            });
            if (!actionRequest.success) {
                throw invocationError('plugin_surface_action_reference_invalid', identity);
            }
            const outcome = await dispatchPluginSurfaceAction({
                // Voice has a caller-local Action namespace but no mounted UI
                // surface. Supplying a contribution id/binding here would
                // manufacture the mounted provenance arm, which is invalid on
                // the truthful `voice` execution surface.
                callerPluginId: input.pluginId,
                action: actionRequest.data.action,
                ...(actionRequest.data.input === undefined ? {} : { input: actionRequest.data.input }),
                ...(input.resolveContributedAction
                    ? { resolveContributedAction: input.resolveContributedAction }
                    : {}),
                ...(clientAction ? { clientAction } : {}),
                invocationSurface: 'voice',
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
        publishCurrentUiContext: unavailable,
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
        openNewSession: async () => unavailable(),
        settleEphemeralInput: async () => unavailable(),
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
