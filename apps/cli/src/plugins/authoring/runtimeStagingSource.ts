import { realpath } from 'node:fs/promises';

import {
  evaluatePluginAuthorStagingSource,
  resolvePluginAuthorStagingModule,
  type EvaluatedPluginAuthorSource,
} from './sourceModule';
import { activateContributionModule } from '../runtime/lifecycle/activation/activateContributionModule';
import type { ValidatedAgentSessionRunnerFactoryFactV1 } from '../runtime/activationSources';
import type { PluginModuleNamespace } from '../runtime/loadPluginModule';
import { readAgentNativeHomeEnvironmentKeys } from './agentNativeHomeEnvironmentKeys';

export type EvaluatedPluginAuthorRuntimeStagingSource = Readonly<{
  evaluated: EvaluatedPluginAuthorSource;
  sessionRunnerFactories: readonly ValidatedAgentSessionRunnerFactoryFactV1[];
  agentNativeHomeEnvironmentKeys: readonly string[];
}>;

export type PluginAuthorRuntimeStagingAuthority =
  | Readonly<{ kind: 'external' }>
  | Readonly<{
    /**
     * Granted only by a caller that already selected this exact root from the
     * canonical bundled workspace inventory. The source manifest must still
     * agree with that caller-owned identity before activation is allowed.
     */
    kind: 'bundled_first_party';
    pluginId: string;
    packageRootPath: string;
  }>;

async function resolveRuntimeStagingManifestAuthority(input: Readonly<{
  authority?: PluginAuthorRuntimeStagingAuthority;
  evaluated: EvaluatedPluginAuthorSource;
  rootPath: string;
}>): Promise<'external' | 'bundled_first_party'> {
  const authority = input.authority ?? { kind: 'external' as const };
  if (authority.kind === 'external') return 'external';
  if (input.evaluated.manifest.id !== authority.pluginId) {
    throw new Error(
      `Bundled plugin staging identity '${authority.pluginId}' does not match source manifest '${input.evaluated.manifest.id}'`,
    );
  }
  const [authorizedRootPath, evaluatedRootPath] = await Promise.all([
    realpath(authority.packageRootPath),
    realpath(input.rootPath),
  ]);
  if (authorizedRootPath !== evaluatedRootPath) {
    throw new Error(
      `Bundled plugin staging source root '${evaluatedRootPath}' does not match authorized root '${authorizedRootPath}'`,
    );
  }
  return 'bundled_first_party';
}

export async function evaluatePluginAuthorRuntimeStagingSource(params: Readonly<{
  locator: string;
  rootPath: string;
  authority?: PluginAuthorRuntimeStagingAuthority;
  loadModule?: (entryPath: string) => Promise<PluginModuleNamespace>;
}>): Promise<EvaluatedPluginAuthorRuntimeStagingSource> {
  const owned = await evaluatePluginAuthorStagingSource(params);
  const manifestAuthority = await resolveRuntimeStagingManifestAuthority({
    authority: params.authority,
    evaluated: owned.evaluated,
    rootPath: params.rootPath,
  });
  const activation = await activateContributionModule({
    pluginId: owned.evaluated.manifest.id,
    manifestAuthority,
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
      throw new Error(
        activation.diagnostics.map((diagnostic) => diagnostic.message).join('; ')
        || `Plugin '${owned.evaluated.manifest.id}' author runtime staging activation failed`,
      );
    }
    return Object.freeze({
      evaluated: owned.evaluated,
      sessionRunnerFactories: activation.validatedAgentSessionRunnerFactories,
      agentNativeHomeEnvironmentKeys: Object.freeze([...new Set(
        activation.registrations.flatMap((registration) => {
          if (registration.family !== 'agents') return [];
          return readAgentNativeHomeEnvironmentKeys(
            registration.value.connectedAccountLaunch?.stateSharingDescriptor,
          );
        }),
      )].sort()),
    });
  } finally {
    await activation.dispose();
  }
}
