import {
  evaluatePluginAuthorStagingSource,
  resolvePluginAuthorStagingModule,
  type EvaluatedPluginAuthorSource,
} from './sourceModule';
import { activateContributionModule } from '../runtime/lifecycle/activation/activateContributionModule';
import type { ValidatedAgentSessionRunnerFactoryFactV1 } from '../runtime/activationSources';
import type { PluginModuleNamespace } from '../runtime/loadPluginModule';
import { PluginDiagnosticError } from '../runtime/moduleFailure';

export type EvaluatedPluginAuthorRuntimeStagingSource = Readonly<{
  evaluated: EvaluatedPluginAuthorSource;
  sessionRunnerFactories: readonly ValidatedAgentSessionRunnerFactoryFactV1[];
}>;

export type PluginAuthorRuntimeStagingAuthority =
  | Readonly<{ kind: 'external' }>
  | Readonly<{
    /**
     * Granted only by a caller that already selected this exact root from the
     * canonical bundled workspace inventory.
     */
    kind: 'bundled_first_party';
    pluginId: string;
    packageRootPath: string;
  }>;

export async function evaluatePluginAuthorRuntimeStagingSource(params: Readonly<{
  locator: string;
  rootPath: string;
  authority?: PluginAuthorRuntimeStagingAuthority;
  loadModule?: (entryPath: string) => Promise<PluginModuleNamespace>;
}>): Promise<EvaluatedPluginAuthorRuntimeStagingSource> {
  const owned = await evaluatePluginAuthorStagingSource(params);
  const activation = await activateContributionModule({
    pluginId: owned.evaluated.manifest.id,
    manifestAuthority: params.authority?.kind ?? 'external',
    occurrenceId: 'author-runtime-staging',
    manifest: owned.evaluated.manifest,
    moduleNamespace: owned.evaluated.module,
    isOccurrenceCurrent: () => true,
    forceActivation: true,
    resolveRelativeModule: async (module) => (
      await resolvePluginAuthorStagingModule({ graph: owned.graph, module })
    ),
  });
  try {
    if (activation.status === 'unavailable') {
      throw new PluginDiagnosticError(activation.diagnostics[0] ?? {
        code: 'plugin_activation_failed',
        message: 'Plugin author runtime staging activation failed',
        details: { cause: { phase: 'activate', code: 'UNKNOWN', retryable: 'unknown' } },
      });
    }
    return Object.freeze({
      evaluated: owned.evaluated,
      sessionRunnerFactories: activation.validatedAgentSessionRunnerFactories,
    });
  } finally {
    await activation.dispose();
  }
}
