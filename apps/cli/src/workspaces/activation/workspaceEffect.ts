import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionInputs } from '@/plugins/projection/registry/types';
import { loadAdmittedPluginProcessRegistrations } from '@/plugins/runtime/lifecycle/activation/admittedProcessPlugins';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '@/scm/pluginBackends/runtimeRegistry';
import { createScmBackendRegistry } from '@/scm/registry';
import { activateScmRuntimeContributionsOnDemand } from '@/scm/scmBackendCatalog';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { materializeProjectCheckout, type MaterializedProjectCheckout } from './materializeProjectCheckout';
import { readProjectCloneSource } from './readProjectCloneSource';
import { privateProjectCheckoutRefusal } from './privateProjectCheckout';

export type WorkspaceCheckoutEffect = Readonly<{
  request: OpenProjectInputV1;
  workspaceRefId: string;
  workspaceRoot: string;
  existingRootPath?: string;
  generation: number;
  plugins: readonly AdmittedBackgroundServicePlugin[];
  contributions: Pick<ResolvedContributionInputs,
    'activationTargets' | 'scmBackends' | 'scmHostingProviders' | 'connectedAccountDescriptors' | 'systemTools'>;
}>;

export type WorkspaceCheckoutEffectContext = Readonly<{
  signal: AbortSignal;
  /** Existing duplex process-service client. The host retains the exact
   * requester owner and currentness; no Account credential crosses here. */
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts' | 'materialize'>;
  onEffectsIssued(): void;
}>;

/** The incumbent held runtime supplies admission, projection and currentness.
 * No discovery, registry or trust decision is repeated by Workspace. */
export async function prepareWorkspaceCheckoutEffect(input: Readonly<{
  request: OpenProjectInputV1;
  workspaceRefId: string;
  workspaceRoot: string;
  existingRootPath?: string;
  registry: ResolvedExecutablePluginRuntimeRegistry;
}>): Promise<Readonly<{ effect: WorkspaceCheckoutEffect; assertCurrent(): void }>> {
  if (input.request.materialization.kind === 'attach' && input.existingRootPath) {
    const admitted = input.request.cloneSource ? await prepareAdmittedScmEffect({ registry: input.registry }) : {
      effect: { generation: input.registry.generation, plugins: [], contributions: {} }, assertCurrent() {},
    };
    return { effect: { request: input.request, workspaceRefId: input.workspaceRefId, workspaceRoot: input.workspaceRoot,
      existingRootPath: input.existingRootPath, ...admitted.effect }, assertCurrent: admitted.assertCurrent };
  }
  if (input.request.source.kind !== 'repository' && input.request.materialization.kind !== 'sync') throw privateProjectCheckoutRefusal('workspace_private_checkout_review_required');
  const admitted = await prepareAdmittedScmEffect({ registry: input.registry,
    ...(input.request.source.kind === 'repository' ? { providerId: input.request.source.selector.provider.id } : {}),
  });
  return { assertCurrent: admitted.assertCurrent, effect: {
    request: input.request, workspaceRefId: input.workspaceRefId, workspaceRoot: input.workspaceRoot, ...admitted.effect,
  } };
}

export type AdmittedScmEffect = Pick<WorkspaceCheckoutEffect, 'generation' | 'plugins' | 'contributions'>;

/** Captures SCM from the same held, admitted runtime for native checkout. */
export async function prepareAdmittedScmEffect(input: Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  providerId?: string;
}>): Promise<Readonly<{ effect: AdmittedScmEffect; assertCurrent(): void }>> {
  await activateScmRuntimeContributionsOnDemand(input.registry);
  const contributes = input.registry.contributes;
  const providerId = input.providerId;
  const scmHostingProviders = (contributes.scmHostingProviders ?? []).filter(entry => providerId === undefined || `${entry.pluginId}/${entry.definition.id}` === providerId);
  const admittedBackendPlugins = new Set([...(input.registry.scmBackendsById?.values() ?? [])].map(entry => entry.pluginId));
  const scmBackends = (contributes.scmBackends ?? []).filter(entry => entry.pluginId && admittedBackendPlugins.has(entry.pluginId));
  const pluginIds = [...new Set([...scmBackends, ...scmHostingProviders].flatMap(entry => entry.pluginId ? [entry.pluginId] : []))];
  if (!input.registry.readAdmittedBackgroundServicePlugins) throw privateProjectCheckoutRefusal();
  const plugins = input.registry.readAdmittedBackgroundServicePlugins(pluginIds);
  const assertCurrent = () => {
    if (!plugins.every(plugin => input.registry.isPluginOccurrenceCurrent(plugin.target.pluginId, plugin.occurrenceId))) {
      throw privateProjectCheckoutRefusal('workspace_private_checkout_retired');
    }
  };
  assertCurrent();
  return { assertCurrent, effect: { generation: input.registry.generation, plugins,
    contributions: { activationTargets: plugins.map(plugin => plugin.target), scmBackends, scmHostingProviders,
      connectedAccountDescriptors: contributes.connectedAccountDescriptors,
      systemTools: (contributes.systemTools ?? []).filter(entry => entry.pluginId !== undefined && pluginIds.includes(entry.pluginId)),
    } } };
}

/** The admitted plugin projection is loaded once in the member process for
 * checkout or retained Sync; SCM never falls back to daemon-owned discovery. */
export async function createWorkspaceEffectScmRegistry(input: AdmittedScmEffect, context: Pick<WorkspaceCheckoutEffectContext, 'connectedAccounts'>) {
  const contributes = createResolvedContributionRegistry(input.contributions);
  const loaded = await loadAdmittedPluginProcessRegistrations(input.plugins, input.generation,
    async () => { throw privateProjectCheckoutRefusal(); }, contributes);
  try {
    const projected = createPluginScmBackendRegistryFromRuntimeRegistry({ contributes,
      scmBackendsById: loaded.scmBackendsById, scmBackendRegistrations: loaded.scmBackendRegistrations,
      scmHostingProvidersById: loaded.scmHostingProvidersById, envAllowedNamesByPluginId: loaded.envAllowedNamesByPluginId,
      resolveConnectedAccountPurposeBindingOwner: () => context.connectedAccounts ?? null });
    return { registry: createScmBackendRegistry(projected.backends), dispose: () => loaded.dispose() };
  } catch (error) { await loaded.dispose(); throw error; }
}

/** Native child only. The SAME trusted checkout owner performs reservation,
 * clone, publish and readback under the identity that owns the files. This is
 * operation placement; installed plugins remain trusted code. */
export async function executeWorkspaceCheckoutEffect(input: WorkspaceCheckoutEffect,
  context: WorkspaceCheckoutEffectContext): Promise<MaterializedProjectCheckout> {
  const request = OpenProjectInputV1Schema.parse(input.request);
  const expectedRoot = join(input.workspaceRoot, input.workspaceRefId);
  // Physical readback belongs to the member that owns the private checkout.
  // The daemon receives this result only through its captured admitted child.
  const verified = async (checkout: MaterializedProjectCheckout): Promise<MaterializedProjectCheckout> => {
    if (checkout.rootPath !== expectedRoot || await realpath(checkout.rootPath) !== expectedRoot
      || !isCanonicalAbsolutePathInsideRoot(expectedRoot, await realpath(checkout.directory)))
      throw privateProjectCheckoutRefusal();
    return checkout;
  };
  const clone = request.source.kind === 'repository' && request.materialization.kind === 'clone'
    && request.materialization.destinationDirectoryName === input.workspaceRefId
    && request.materialization.destinationParentPath === input.workspaceRoot;
  const attach = request.source.kind === 'workspace' && request.materialization.kind === 'attach'
    && input.existingRootPath === expectedRoot;
  if (!clone && !attach) {
    throw privateProjectCheckoutRefusal('workspace_private_checkout_review_required');
  }
  context.signal.throwIfAborted();
  if (attach) {
    if (await realpath(expectedRoot) !== expectedRoot) throw privateProjectCheckoutRefusal();
    const gitPath = join(expectedRoot, '.git');
    const metadata = await lstat(gitPath).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(gitPath) !== gitPath
      || await lstat(join(gitPath, 'commondir')).then(() => true, error => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error;
      }))) throw privateProjectCheckoutRefusal('workspace_git_metadata_shared');
    const checkout = await verified(await materializeProjectCheckout({ materialization: { kind: 'attach' }, sourceDirectory: expectedRoot,
      sourceRootPath: expectedRoot, subdir: request.subdir, signal: context.signal }));
    if (!request.cloneSource) return checkout;
    const registry = await createWorkspaceEffectScmRegistry(input, context);
    try {
      return { ...checkout, cloneSource: await readProjectCloneSource({ directory: checkout.directory,
        registry: registry.registry, signal: context.signal }) };
    } finally { await registry.dispose(); }
  }
  const registry = await createWorkspaceEffectScmRegistry(input, context);
  try {
    context.signal.throwIfAborted();
    if (request.source.kind !== 'repository') throw privateProjectCheckoutRefusal('workspace_private_checkout_review_required');
    return await verified(await materializeProjectCheckout({ materialization: request.materialization,
      selector: request.source.selector, ref: request.ref, subdir: request.subdir,
      registry: registry.registry, signal: context.signal,
      onEffectsIssued: context.onEffectsIssued,
    }));
  } finally { await registry.dispose(); }
}
