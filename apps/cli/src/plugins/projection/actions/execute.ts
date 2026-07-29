import { ACTION_IDS, type ActionId } from '@happier-dev/protocol/actions';

import type {
  ResolvedActionContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import type { PluginActionSurface } from '@/plugins/runtime/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';

type PluginActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

export type PluginActionExecutionAttempt = Readonly<
  | { matched: false }
  | { matched: true; result: PluginActionExecutorResult }
>;

type PluginActionExecutionRegistry = ResolvedContributionRegistry | ResolvedExecutablePluginRuntimeRegistry;

const BUILT_IN_ACTION_IDS = new Set<string>(ACTION_IDS);

function isBuiltInActionId(actionId: string): boolean {
  return BUILT_IN_ACTION_IDS.has(actionId);
}

function isExecutablePluginRuntimeRegistry(
  registry: PluginActionExecutionRegistry,
): registry is ResolvedExecutablePluginRuntimeRegistry {
  return 'contributes' in registry;
}

function readContributionRegistry(registry: PluginActionExecutionRegistry): ResolvedContributionRegistry {
  return isExecutablePluginRuntimeRegistry(registry) ? registry.contributes : registry;
}

async function activateOwningPluginForAction(params: Readonly<{
  registry: PluginActionExecutionRegistry;
  contributes: ResolvedContributionRegistry;
  action: ResolvedActionContribution;
}>): Promise<PluginActionExecutorResult | null> {
  if (!isExecutablePluginRuntimeRegistry(params.registry)) {
    return null;
  }
  const pluginId = params.action.pluginId;
  if (!pluginId) {
    return null;
  }
  const activationResults = await params.registry.activateContributionsOnDemand([{
    pluginId,
    family: 'actions',
    localId: params.action.definition.id,
  }]);
  const diagnostics = activationResults.find((result) => result.pluginId === pluginId)?.diagnostics ?? [];
  const activationFailure = diagnostics.find((diagnostic) => diagnostic.code === 'plugin_activation_failed');
  if (!activationFailure) {
    return null;
  }
  return {
    ok: false,
    errorCode: activationFailure.code,
    error: activationFailure.message,
  };
}

export async function executePluginActionIfAvailable(params: Readonly<{
  registry?: ResolvedContributionRegistry;
  runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  actionId: ActionId | string;
  input: unknown;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  context: Readonly<{
    defaultSessionId?: string;
    surface?: PluginActionSurface;
    signal?: AbortSignal;
    facts?: ContributionPolicyFacts;
  }>;
}>): Promise<PluginActionExecutionAttempt> {
  const actionId = String(params.actionId);
  if (!params.runtimeRegistry && !params.registry && isBuiltInActionId(actionId)) {
    return { matched: false };
  }

  const registry = params.runtimeRegistry
    ?? params.registry;
  if (!registry) {
    return { matched: false };
  }
  const contributes = readContributionRegistry(registry);
  const action = contributes.actionsById?.get(actionId);
  if (!action) {
    return { matched: false };
  }

  const surface = params.context.surface ?? 'cli';
  if (action.definition.surfaces[surface] !== true) {
    return {
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_unavailable',
        error: 'Plugin action is not available on the requested surface',
      },
    };
  }

  const pluginId = action.pluginId;
  if (!pluginId) {
    return {
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_handler_missing',
        error: 'Plugin action requires a daemon entry handler',
      },
    };
  }

  const targetActionInvocations = isExecutablePluginRuntimeRegistry(registry)
    ? registry.targetActionInvocations
    : undefined;
  if (targetActionInvocations?.expects(pluginId, action.definition.id)) {
    if (!targetActionInvocations.has(pluginId, action.definition.id)) {
      let activationFailure: PluginActionExecutorResult | null;
      try {
        activationFailure = await activateOwningPluginForAction({
          registry,
          contributes,
          action,
        });
      } catch (error) {
        return {
          matched: true,
          result: {
            ok: false,
            errorCode: 'plugin_activation_failed',
            error: error instanceof Error ? error.message : 'Plugin target action activation failed',
          },
        };
      }
      if (activationFailure) {
        return { matched: true, result: activationFailure };
      }
    }
    if (!targetActionInvocations.has(pluginId, action.definition.id)) {
      return {
        matched: true,
        result: {
          ok: false,
          errorCode: 'plugin_action_handler_missing',
          error: 'Declared target action did not publish a committed generation handler',
        },
      };
    }
    const targetResult = await targetActionInvocations.invoke({
      pluginId,
      localId: action.definition.id,
      input: params.input,
      surface,
      ...(params.context.defaultSessionId ? { sessionId: params.context.defaultSessionId } : {}),
      ...(params.context.signal ? { signal: params.context.signal } : {}),
      ...(params.context.facts ? { facts: params.context.facts } : {}),
      ...(params.requestCurrentIntent ? { requestCurrentIntent: params.requestCurrentIntent } : {}),
    });
    return targetResult.status === 'executed'
      ? { matched: true, result: { ok: true, result: targetResult.value } }
      : { matched: true, result: { ok: false, errorCode: targetResult.code, error: targetResult.message } };
  }

  return {
    matched: true,
    result: {
      ok: false,
      errorCode: 'plugin_action_handler_missing',
      error: 'Plugin action is not bound through named activation',
    },
  };
}
