import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionInputs } from '@/plugins/projection/registry/types';
import { loadAdmittedPluginProcessRegistrations } from '@/plugins/runtime/lifecycle/activation/admittedProcessPlugins';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';
import { createRuntimeBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '@/scm/pluginBackends/runtimeRegistry';
import { createScmBackendRegistry } from '@/scm/registry';
import { activateScmRuntimeContributionsOnDemand } from '@/scm/scmBackendCatalog';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { materializeProjectCheckout, type MaterializedProjectCheckout } from './materializeProjectCheckout';
import { readProjectCloneSource } from './readProjectCloneSource';
import { privateProjectCheckoutRefusal, resolvePrivateProjectCheckoutRoot } from './privateProjectCheckout';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';

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
  const existing = input.request.source.kind === 'workspace' && input.existingRootPath
    && (input.request.materialization.kind === 'attach' || input.request.materialization.kind === 'worktree');
  if (!existing && input.request.source.kind !== 'repository' && input.request.materialization.kind !== 'sync')
    throw privateProjectCheckoutRefusal('workspace_private_checkout_review_required');
  const admitted = await prepareAdmittedScmEffect({ registry: input.registry,
    ...(input.request.source.kind === 'repository' ? { providerId: input.request.source.selector.provider.id } : {}),
  });
  return { assertCurrent: admitted.assertCurrent, effect: {
    request: input.request, workspaceRefId: input.workspaceRefId, workspaceRoot: input.workspaceRoot,
    ...(existing ? { existingRootPath: input.existingRootPath } : {}), ...admitted.effect,
  } };
}

export type AdmittedScmEffect = Pick<WorkspaceCheckoutEffect, 'generation' | 'plugins' | 'contributions'>;

/** Captures SCM from the same held, admitted runtime for native checkout. */
export async function prepareAdmittedScmEffect(input: Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  providerId?: string;
  managedGuest?: boolean;
}>): Promise<Readonly<{ effect: AdmittedScmEffect; assertCurrent(): void }>> {
  await activateScmRuntimeContributionsOnDemand(input.registry);
  const contributes = input.registry.contributes;
  const providerId = input.providerId;
  const scmHostingProviders = (contributes.scmHostingProviders ?? []).filter(entry => providerId === undefined || `${entry.pluginId}/${entry.definition.id}` === providerId);
  const admittedBackendPlugins = new Set([...(input.registry.scmBackendsById?.values() ?? [])].map(entry => entry.pluginId));
  const scmBackends = (contributes.scmBackends ?? []).filter(entry => entry.pluginId && admittedBackendPlugins.has(entry.pluginId));
  const pluginIds = [...new Set([...scmBackends, ...scmHostingProviders].flatMap(entry => entry.pluginId ? [entry.pluginId] : []))];
  if (!input.registry.readAdmittedBackgroundServicePlugins) throw privateProjectCheckoutRefusal();
  // Only bundled code has an executing-runtime placement on a managed guest.
  // Retain contribution definitions so their existing owners settle missing
  // registrations as unavailable without blocking unrelated folder transfers.
  const placedPluginIds = input.managedGuest ? pluginIds.filter(pluginId => contributes.activationTargets.some(target =>
    target.pluginId === pluginId && target.sourceSpec.kind === 'bundled')) : pluginIds;
  const plugins = input.registry.readAdmittedBackgroundServicePlugins(placedPluginIds);
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
export async function createWorkspaceEffectScmRegistry(input: AdmittedScmEffect,
  context: Pick<WorkspaceCheckoutEffectContext, 'connectedAccounts'> & Readonly<{ managedGuestHome?: string }>) {
  const contributes = createResolvedContributionRegistry(input.contributions);
  // No initialize(): the existing owner admits only this runtime's exact
  // first-party roots lazily. No guest Account discovery or watcher starts.
  const developmentRoots = context.managedGuestHome === undefined ? undefined : createDaemonPluginDevelopmentRootsOwner({
    happyHomeDir: context.managedGuestHome,
    submitObservation: async () => { throw privateProjectCheckoutRefusal(); },
  });
  const bundled = developmentRoots ? createRuntimeBundledActivationSourceResolver({
    activationTargets: input.plugins.map(plugin => plugin.target),
    resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority,
  }) : undefined;
  const loaded = await loadAdmittedPluginProcessRegistrations(input.plugins, input.generation,
    async () => { throw privateProjectCheckoutRefusal(); }, contributes,
    bundled ? { resolveBundledActivationSource: bundled } : undefined)
    .catch(async error => { await developmentRoots?.stop(); throw error; });
  const dispose = async () => { try { await loaded.dispose(); } finally { await developmentRoots?.stop(); } };
  try {
    const projected = createPluginScmBackendRegistryFromRuntimeRegistry({ contributes,
      scmBackendsById: loaded.scmBackendsById, scmBackendRegistrations: loaded.scmBackendRegistrations,
      scmHostingProvidersById: loaded.scmHostingProvidersById, envAllowedNamesByPluginId: loaded.envAllowedNamesByPluginId,
      resolveConnectedAccountPurposeBindingOwner: () => context.connectedAccounts ?? null });
    return { registry: createScmBackendRegistry(projected.backends), dispose };
  } catch (error) { await dispose(); throw error; }
}

/** Native child only. The SAME trusted checkout owner performs reservation,
 * clone, publish and readback under the identity that owns the files. This is
 * operation placement; installed plugins remain trusted code. */
export async function executeWorkspaceCheckoutEffect(input: WorkspaceCheckoutEffect,
  context: WorkspaceCheckoutEffectContext): Promise<MaterializedProjectCheckout> {
  const request = OpenProjectInputV1Schema.parse(input.request);
  const expectedRoot = resolvePrivateProjectCheckoutRoot(input.workspaceRoot, input.workspaceRefId);
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
  const worktree = request.source.kind === 'workspace' && request.materialization.kind === 'worktree'
    && request.materialization.targetPath === expectedRoot
    && input.existingRootPath === resolvePrivateProjectCheckoutRoot(input.workspaceRoot, request.source.workspaceId);
  if (!clone && !attach && !worktree) {
    throw privateProjectCheckoutRefusal('workspace_private_checkout_review_required');
  }
  context.signal.throwIfAborted();
  let scm: Awaited<ReturnType<typeof createWorkspaceEffectScmRegistry>> | undefined;
  const registry = async () => scm ??= await createWorkspaceEffectScmRegistry(input, context);
  try {
    if (attach || worktree) {
      const sourceRoot = input.existingRootPath!;
      if (await realpath(sourceRoot) !== sourceRoot) throw privateProjectCheckoutRefusal();
      const gitPath = join(sourceRoot, '.git');
      const metadata = await lstat(gitPath).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (metadata?.isSymbolicLink() || metadata?.isDirectory() && await realpath(gitPath) !== gitPath)
        throw privateProjectCheckoutRefusal('workspace_git_metadata_shared');
      const linked = metadata && (!metadata.isDirectory() || await lstat(join(gitPath, 'commondir')).then(() => true, error => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error;
      }));
      if (linked) {
        // SCM owns Git's administrative references. Linked worktrees may share
        // that member's private repository, never a host or another member's.
        const inspected = await inspectWorkspaceLocationWithScmWorkspace({ candidatePath: sourceRoot,
          registry: (await registry()).registry, signal: context.signal });
        const repository = inspected?.checkoutDiscovery.find(entry => entry.kind === 'git_worktree')?.repositoryIdentityPath;
        if (!repository || !isCanonicalAbsolutePathInsideRoot(input.workspaceRoot, await realpath(repository)))
          throw privateProjectCheckoutRefusal('workspace_git_metadata_shared');
      }
    }
    if (attach) {
      const checkout = await verified(await materializeProjectCheckout({ materialization: { kind: 'attach' }, sourceDirectory: expectedRoot,
        sourceRootPath: expectedRoot, subdir: request.subdir, signal: context.signal }));
      if (!request.cloneSource) return checkout;
      return { ...checkout, cloneSource: await readProjectCloneSource({ directory: checkout.directory,
        registry: (await registry()).registry, signal: context.signal }) };
    }
    context.signal.throwIfAborted();
    return await verified(await materializeProjectCheckout({ materialization: request.materialization,
      ...(request.source.kind === 'repository' ? { selector: request.source.selector }
        : { sourceDirectory: input.existingRootPath, sourceRootPath: input.existingRootPath }),
      ref: request.ref, subdir: request.subdir,
      registry: (await registry()).registry, signal: context.signal,
      onEffectsIssued: context.onEffectsIssued,
    }));
  } finally { await scm?.dispose(); }
}
