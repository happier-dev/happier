import type {
    PluginSettingsActionDeclarationV2,
} from '@happier-dev/protocol';
import { createHostPluginSettingsActionInvoker } from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import type {
    StablePluginSettingsModel,
    createStablePluginSettingsOwner,
} from './settings';
import type { PluginInvocationServicesSeed } from './types';

type StablePluginSettingsOwner = ReturnType<typeof createStablePluginSettingsOwner>;

export type PluginSettingsActionExecutionInput = Readonly<{
    actionId: string;
    settings: Readonly<Record<string, JsonValue>>;
}>;

export type PluginSettingsActionExecutionResult = Readonly<{
    patch: Readonly<Record<string, JsonValue>>;
}>;

function actionError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

function composeSignal(seed: PluginInvocationServicesSeed, signal?: AbortSignal): AbortSignal {
    return signal && signal !== seed.signal
        ? AbortSignal.any([seed.signal, signal])
        : seed.signal;
}

/**
 * Owns the generic manifest-declared settings action lifecycle. Provider-specific
 * request formation and reconciliation remain behind the execute callback.
 */
export function createPluginSettingsActionInvoker<Context = unknown>(params: Readonly<{
    owner: StablePluginSettingsOwner;
    confirm(input: Readonly<{
        declaration: PluginSettingsActionDeclarationV2;
        signal: AbortSignal;
    }>): boolean | Promise<boolean>;
    execute(
        input: PluginSettingsActionExecutionInput,
        context: Context | undefined,
        options: Readonly<{ signal: AbortSignal }>,
    ): PluginSettingsActionExecutionResult | Promise<PluginSettingsActionExecutionResult>;
}>) {
    type InvocationContext = Readonly<{
        contributionId: string;
        model: StablePluginSettingsModel;
        seed: PluginInvocationServicesSeed;
        expectedRevision?: string;
        authorContext?: Context;
    }>;
    const invoker = createHostPluginSettingsActionInvoker<InvocationContext, unknown>({
        createError: actionError,
        confirm: params.confirm,
        async snapshot({ signal, context }) {
            if (!context) throw actionError('plugin_settings_action_context_missing', 'Plugin settings action host context is missing');
            return await params.owner.bind({ model: context.model, seed: context.seed }).snapshot({ signal });
        },
        async execute(actionInput, context, options) {
            return await params.execute(actionInput, context?.authorContext, options);
        },
        async applyPatch({ declaration, snapshot, patch, signal, context }) {
            if (!context) throw actionError('plugin_settings_action_context_missing', 'Plugin settings action host context is missing');
            return await params.owner.applyActionPatch({
                model: context.model,
                seed: context.seed,
                contributionId: context.contributionId,
                allowedFieldIds: declaration.patchFieldIds,
                patch,
                expectedRevision: context.expectedRevision ?? snapshot.revision,
                signal,
            });
        },
    });

    return Object.freeze({
        async invoke(input: Readonly<{
            declaration: PluginSettingsActionDeclarationV2;
            contributionId: string;
            model: StablePluginSettingsModel;
            seed: PluginInvocationServicesSeed;
            userGesture: boolean;
            expectedRevision?: string;
            signal?: AbortSignal;
            context?: Context;
        }>) {
            const actionKey = `${input.model.identity.pluginId}/${input.seed.generation}/${input.contributionId}/${input.declaration.id}`;
            const signal = composeSignal(input.seed, input.signal);
            return await invoker.invoke({
                key: actionKey,
                declaration: input.declaration,
                userGesture: input.userGesture,
                signal,
                isCurrent: input.seed.isGenerationCurrent,
                context: Object.freeze({
                    contributionId: input.contributionId,
                    model: input.model,
                    seed: input.seed,
                    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
                    ...(input.context === undefined ? {} : { authorContext: input.context }),
                }),
            });
        },
    });
}
